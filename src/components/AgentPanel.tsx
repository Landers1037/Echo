import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, History, LoaderCircle, NotebookPen, Plus, SendHorizontal, Square, Trash2, Undo2, X } from 'lucide-react'
import { ApiError } from '../api'
import { deleteConversation, getConversation, listConversations, setMessageOutcome, streamChat } from '../agent/client'
import type { EditorController } from './Editor'
import type { AgentMessage, AgentMode, AgentToolCall, Conversation } from '../types'
import './AgentPanel.css'

type Review = { messageId: string; failures: string[] }
type Live = { content: string; toolCalls: AgentToolCall[] }

export function AgentPanel({ open, width, note, getNoteContent, editor, onPendingChange, onEnsureSource, onEditsResolved, onRegisterInterrupt, onCollapse }: {
  open: boolean
  width: number
  note: { path: string; title: string } | null
  getNoteContent: () => string
  editor: EditorController | null
  onPendingChange: (pending: boolean) => void
  onEnsureSource: () => void
  onEditsResolved: (action: 'accept' | 'reject') => void
  onRegisterInterrupt: (interrupt: () => void) => void
  onCollapse: () => void
}) {
  const [mode, setMode] = useState<AgentMode>(() => localStorage.getItem('echo:agent-mode') === 'chat' ? 'chat' : 'note')
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState('')
  const [title, setTitle] = useState('新的对话')
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [live, setLive] = useState<Live | null>(null)
  const [review, setReview] = useState<Review | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [confirmId, setConfirmId] = useState('')
  const [error, setError] = useState('')
  const [loadingHistory, setLoadingHistory] = useState(false)
  const runRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const sessionRef = useRef(false)
  const messageIdRef = useRef('')
  const editorRef = useRef(editor)
  const noteRef = useRef(note)
  const activeRef = useRef(activeId)
  const bottomRef = useRef<HTMLDivElement>(null)
  const interruptRef = useRef(() => {})
  editorRef.current = editor
  noteRef.current = note
  activeRef.current = activeId

  function chooseMode(next: AgentMode) {
    setMode(next)
    localStorage.setItem('echo:agent-mode', next)
  }

  function resetSession() {
    sessionRef.current = false
    messageIdRef.current = ''
    setReview(null)
    setLive(null)
    setStreaming(false)
  }

  function interrupt() {
    runRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    if (sessionRef.current) {
      editorRef.current?.resolveAiSession('reject')
      const id = messageIdRef.current
      onEditsResolved('reject')
      if (id) void setMessageOutcome(id, 'rejected', '已撤销未确认的修改').catch(() => {})
    }
    onPendingChange(false)
    resetSession()
  }
  interruptRef.current = interrupt

  useEffect(() => {
    onRegisterInterrupt(() => interruptRef.current())
    return () => onRegisterInterrupt(() => {})
  }, [onRegisterInterrupt])
  useEffect(() => () => { interruptRef.current() }, [])
  useEffect(() => { bottomRef.current?.scrollIntoView?.({ block: 'end' }) }, [messages, live, review])

  async function refreshHistory() {
    setLoadingHistory(true)
    try { setConversations(await listConversations()) }
    catch (err) { setError((err as Error).message) }
    finally { setLoadingHistory(false) }
  }

  async function openConversation(id: string) {
    if (streaming || review) return
    const detail = await getConversation(id)
    setActiveId(detail.conversation.id)
    setTitle(detail.conversation.title || '新的对话')
    setMessages(detail.messages.filter(item => item.role !== 'tool'))
    chooseMode(detail.conversation.mode)
    localStorage.setItem('echo:agent-conversation', detail.conversation.id)
    setHistoryOpen(false)
    setError('')
  }

  function newChat() {
    if (streaming || review) return
    setActiveId('')
    setTitle('新的对话')
    setMessages([])
    setError('')
    setHistoryOpen(false)
    localStorage.removeItem('echo:agent-conversation')
  }

  async function removeConversation(id: string) {
    await deleteConversation(id)
    setConversations(list => list.filter(item => item.id !== id))
    setConfirmId('')
    if (activeRef.current === id) newChat()
  }

  async function finishTurn(run: number, acc: Live, reload: boolean) {
    if (run !== runRef.current) return
    if (reload && activeRef.current) {
      try {
        const detail = await getConversation(activeRef.current)
        if (run !== runRef.current) return
        setTitle(detail.conversation.title || '新的对话')
        setMessages(detail.messages.filter(item => item.role !== 'tool'))
        const last = [...detail.messages].reverse().find(item => item.role === 'assistant')
        if (last) messageIdRef.current = last.id
        setLive(null)
      } catch {
        if (acc.content || acc.toolCalls.length) setMessages(list => [...list, localAssistant(run, activeRef.current, acc)])
        setLive(null)
      }
    } else if (acc.content || acc.toolCalls.length || messageIdRef.current) {
      setMessages(list => [...list, localAssistant(run, activeRef.current, acc)])
      setLive(null)
    } else setLive(null)
    if (run !== runRef.current) return
    if (sessionRef.current) {
      const result = editorRef.current?.finishAiSession() ?? { failures: [] }
      setReview({ messageId: messageIdRef.current, failures: result.failures })
    } else onPendingChange(false)
  }

  async function send() {
    const text = input.trim()
    if (!text || streaming || review || (mode === 'note' && !note)) return
    const run = ++runRef.current
    const controller = new AbortController()
    abortRef.current = controller
    sessionRef.current = false
    messageIdRef.current = ''
    setInput('')
    setError('')
    setStreaming(true)
    setHistoryOpen(false)
    if (mode === 'note') onPendingChange(true)
    const acc: Live = { content: '', toolCalls: [] }
    setMessages(list => [...list, { id: `local-user-${run}`, conversationId: activeId, role: 'user', content: text, createdAt: new Date().toISOString() }])
    setLive(acc)
    try {
      const currentNote = noteRef.current
      for await (const event of streamChat({
        conversationId: activeRef.current || undefined,
        mode,
        message: text,
        note: mode === 'note' && currentNote ? { path: currentNote.path, content: getNoteContent() } : undefined,
      }, controller.signal)) {
        if (run !== runRef.current) return
        if (event.type === 'meta') {
          setActiveId(event.conversationId)
          activeRef.current = event.conversationId
          setTitle(event.title || '新的对话')
          localStorage.setItem('echo:agent-conversation', event.conversationId)
          void refreshHistory()
        } else if (event.type === 'delta') {
          acc.content += event.text
          setLive({ content: acc.content, toolCalls: acc.toolCalls.map(item => ({ ...item })) })
        } else if (event.type === 'tool_start' || event.type === 'tool_delta' || event.type === 'tool_end') {
          if (!sessionRef.current) {
            onEnsureSource()
            editorRef.current?.beginAiSession()
            sessionRef.current = true
            onPendingChange(true)
          }
          const existing = acc.toolCalls.find(item => item.id === event.id)
          if (event.type === 'tool_start' && !existing) acc.toolCalls.push({ id: event.id, name: event.name, arguments: '' })
          const tool = acc.toolCalls.find(item => item.id === event.id)
          if (tool && event.type !== 'tool_start') {
            tool.arguments = event.type === 'tool_end' ? event.arguments : tool.arguments + event.arguments
            editorRef.current?.applyAiStream(tool.id, tool.name, tool.arguments)
          }
          setLive({ content: acc.content, toolCalls: acc.toolCalls.map(item => ({ ...item })) })
        } else if (event.type === 'error') {
          setError(event.error)
          if (event.messageId) messageIdRef.current = event.messageId
        } else if (event.type === 'done') {
          messageIdRef.current = event.messageId
        }
      }
      if (run !== runRef.current) return
      await finishTurn(run, acc, false)
    } catch (err) {
      if (run !== runRef.current) return
      if (!controller.signal.aborted) {
        setError((err as Error).message)
        if (err instanceof ApiError && typeof err.data.conversationId === 'string') {
          setActiveId(err.data.conversationId)
          activeRef.current = err.data.conversationId
          if (typeof err.data.title === 'string' && err.data.title) setTitle(err.data.title)
        }
      }
      await finishTurn(run, acc, controller.signal.aborted || Boolean(activeRef.current))
    } finally {
      if (run === runRef.current) {
        abortRef.current = null
        setStreaming(false)
      }
    }
  }

  async function resolveReview(action: 'accept' | 'reject') {
    if (!review) return
    editorRef.current?.resolveAiSession(action)
    sessionRef.current = false
    onPendingChange(false)
    onEditsResolved(action)
    const id = review.messageId
    const detail = review.failures.join('；')
    setReview(null)
    setMessages(list => list.map(item => item.id === id ? { ...item, outcome: action === 'accept' ? 'accepted' : 'rejected' } : item))
    if (!id) return
    try { await setMessageOutcome(id, action === 'accept' ? 'accepted' : 'rejected', detail) }
    catch (err) { setError((err as Error).message) }
  }

  const blocked = streaming || Boolean(review)
  return <aside className={open ? 'agent-panel' : 'agent-panel collapsed'} style={open ? { width } : undefined} aria-hidden={!open} aria-label="笔记 Agent">
    <header className="agent-header">
      <strong title={title}>{title || '新的对话'}</strong>
      <button type="button" className="icon-button" aria-label="历史对话" aria-expanded={historyOpen} onClick={() => { const next = !historyOpen; setHistoryOpen(next); setConfirmId(''); if (next) void refreshHistory() }}><History size={16} /></button>
      <button type="button" className="icon-button" aria-label="新建聊天" disabled={blocked} onClick={newChat}><Plus size={16} /></button>
      <button type="button" className="icon-button" aria-label="关闭 Agent" onClick={onCollapse}><X size={16} /></button>
    </header>
    {historyOpen && <div className="agent-history">
      {loadingHistory && <p className="field-help"><LoaderCircle size={14} className="spin" /> 正在读取…</p>}
      {conversations.map(item => <div className={item.id === activeId ? 'agent-history-row active' : 'agent-history-row'} key={item.id}>
        <button type="button" onClick={() => void openConversation(item.id).catch(err => setError((err as Error).message))} disabled={blocked}>
          <strong>{item.title || '新的对话'}</strong>
          <small>{item.mode === 'note' ? '笔记' : '聊天'}{item.notePath ? ` · ${item.notePath}` : ''}</small>
        </button>
        {confirmId === item.id
          ? <button type="button" className="agent-confirm-delete" onClick={() => void removeConversation(item.id).catch(err => setError((err as Error).message))}>确认删除</button>
          : <button type="button" className="icon-button" aria-label={`删除 ${item.title || '对话'}`} onClick={() => setConfirmId(item.id)}><Trash2 size={14} /></button>}
      </div>)}
      {!loadingHistory && !conversations.length && <p className="field-help">还没有对话</p>}
    </div>}
    <div className="agent-transcript">
      {!messages.length && !live && <div className="agent-empty"><NotebookPen size={28} strokeWidth={1.4} /><p>{mode === 'note' ? '笔记模式会修改当前打开的笔记。修改会先标出来，你可以保留或撤销。' : '聊天模式只对话，不会改动笔记。'}</p></div>}
      {messages.filter(item => item.role !== 'tool').map(item => <MessageBubble key={item.id} message={item} pending={review?.messageId === item.id} />)}
      {live && <MessageBubble message={{ id: 'live', conversationId: activeId, role: 'assistant', content: live.content, toolCalls: live.toolCalls, createdAt: '' }} pending={sessionRef.current} thinking={streaming} />}
      <div ref={bottomRef} />
    </div>
    {error && <p className="agent-error" role="alert">{error}<button type="button" aria-label="关闭错误" onClick={() => setError('')}><X size={13} /></button></p>}
    {review && <div className="agent-review" role="status">
      <span>{review.failures.length ? `部分修改未应用：${review.failures.join('；')}` : 'AI 已修改当前笔记'}</span>
      <button type="button" onClick={() => void resolveReview('accept')}><Check size={14} />保留</button>
      <button type="button" onClick={() => void resolveReview('reject')}><Undo2 size={14} />撤销</button>
    </div>}
    <form className="agent-composer" onSubmit={event => { event.preventDefault(); void send() }}>
      <textarea rows={1} value={input} placeholder={mode === 'note' && !note ? '请先打开一篇笔记' : '输入消息，Enter 发送'} aria-label="Agent 消息" disabled={Boolean(review)} onChange={event => setInput(event.target.value)} onInput={event => { const node = event.currentTarget; node.style.height = 'auto'; node.style.height = `${Math.min(node.scrollHeight, 160)}px` }} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send() } }} />
      <div className="agent-compose-bar">
        <div className="agent-mode" role="group" aria-label="对话模式">
          <button type="button" aria-pressed={mode === 'note'} onClick={() => chooseMode('note')}>笔记</button>
          <button type="button" aria-pressed={mode === 'chat'} onClick={() => chooseMode('chat')}>聊天</button>
        </div>
        {mode === 'note' && <span className="agent-target">{note ? note.title : '未打开笔记'}</span>}
        {streaming
          ? <button type="button" className="agent-send" aria-label="停止" onClick={() => abortRef.current?.abort()}><Square size={14} /></button>
          : <button type="submit" className="agent-send" aria-label="发送" disabled={!input.trim() || Boolean(review) || (mode === 'note' && !note)}><SendHorizontal size={15} /></button>}
      </div>
    </form>
  </aside>
}

function localAssistant(run: number, conversationId: string, acc: Live): AgentMessage {
  return { id: `local-assistant-${run}`, conversationId, role: 'assistant', content: acc.content, toolCalls: acc.toolCalls, createdAt: new Date().toISOString() }
}

function toolLabel(name: string) {
  if (name === 'edit_note') return '修改笔记'
  if (name === 'append_to_note') return '追加内容'
  if (name === 'rewrite_note') return '重写笔记'
  return '调用工具'
}

function MessageBubble({ message, pending, thinking = false }: { message: AgentMessage; pending: boolean; thinking?: boolean }) {
  const outcome = message.outcome === 'accepted' ? '已保留' : message.outcome === 'rejected' ? '已撤销' : pending ? '等待确认' : message.toolCalls?.length ? '未确认' : ''
  return <article className={`agent-bubble ${message.role}`}>
    {message.role === 'assistant' && message.content && <div className="agent-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: props => <a href={props.href} target="_blank" rel="noreferrer">{props.children}</a> }}>{message.content}</ReactMarkdown></div>}
    {message.role === 'user' && <p>{message.content}</p>}
    {message.toolCalls?.map(call => <div className="agent-tool" key={call.id}><NotebookPen size={14} /><span>{toolLabel(call.name)}</span>{outcome && <small>{outcome}</small>}</div>)}
    {thinking && <p className="agent-thinking" role="status">思考中</p>}
  </article>
}

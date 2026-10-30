import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError, json, query } from '../../api'
import type { Annotation, AnnotationHighlight, AnnotationList, AnnotationStroke } from '../../types'
import { annotationColors, annotationStrokePixels } from './anchor'

export type AnnotationToolName = 'browse' | 'pen' | 'highlight' | 'eraser'
export type AnnotationDraft = {
  kind: Annotation['kind']
  anchorLine: number
  anchorText: string
  color: string
  data: AnnotationStroke | AnnotationHighlight
  comment: string
}

type Undo =
  | { op: 'create'; id: string }
  | { op: 'remove'; item: Annotation }
  | { op: 'remove-many'; items: Annotation[] }
  | { op: 'update'; id: string; comment: string }

type AnnotationState = AnnotationList & { path: string }

export function useAnnotations(notePath: string | undefined, notify: (text: string, error?: boolean) => void) {
  const [state, setState] = useState<AnnotationState | null>(null)
  const [toolOpen, setToolOpen] = useState(false)
  const [tool, setTool] = useState<AnnotationToolName>('pen')
  const [color, setColor] = useState<string>(annotationColors[0])
  const [strokePixels, setStrokePixels] = useState<number>(annotationStrokePixels[1])
  const [staleIds, setStaleIdsState] = useState<string[]>([])
  const [undoCount, setUndoCount] = useState(0)
  const stateRef = useRef(state)
  const pathRef = useRef(notePath)
  const toolOpenRef = useRef(false)
  const undoRef = useRef<Undo[]>([])
  const dropped = useRef(new Set<string>())
  const listRequest = useRef(0)
  const visibilityEpoch = useRef(0)
  stateRef.current = state
  pathRef.current = notePath
  toolOpenRef.current = toolOpen

  const resetHistory = useCallback(() => {
    undoRef.current = []
    setUndoCount(0)
    setStaleIdsState([])
  }, [])

  const closeTool = useCallback(() => setToolOpen(false), [])

  useEffect(() => {
    resetHistory()
    setToolOpen(false)
    if (!notePath) { setState(null); return }
    const request = ++listRequest.current
    const epoch = visibilityEpoch.current
    setState(null)
    void api<AnnotationList>(`/annotations?path=${query(notePath)}`).then(list => {
      if (listRequest.current !== request || pathRef.current !== notePath) return
      setState(current => {
        const serverItems = list.items || []
        const pending = current?.path === notePath ? current.items.filter(item => !serverItems.some(saved => saved.id === item.id)) : []
        return { path: notePath, visible: visibilityEpoch.current === epoch ? list.visible : (current?.visible ?? list.visible), items: [...serverItems, ...pending] }
      })
    }).catch(() => {
      if (listRequest.current !== request || pathRef.current !== notePath) return
      setState(current => current ?? { path: notePath, visible: false, items: [] })
    })
  }, [notePath, resetHistory])

  const remember = useCallback((entry: Undo) => {
    undoRef.current = [...undoRef.current, entry].slice(-30)
    setUndoCount(undoRef.current.length)
  }, [])

  const setNoteVisible = useCallback(async (path: string, visible: boolean) => {
    const epoch = ++visibilityEpoch.current
    const previous = stateRef.current?.path === path ? stateRef.current.visible : undefined
    setState(current => {
      if (current?.path === path) return { ...current, visible }
      if (pathRef.current === path) return { path, visible, items: current?.items || [] }
      return current
    })
    try {
      await api('/annotations/visibility', json('PUT', { path, visible }))
      if (visibilityEpoch.current !== epoch) return
      setState(current => current?.path === path ? { ...current, visible } : current)
      if (!visible && pathRef.current === path) setToolOpen(false)
    } catch (error) {
      if (visibilityEpoch.current === epoch) setState(current => current?.path === path ? { ...current, visible: previous ?? false } : current)
      notify((error as Error).message, true)
      throw error
    }
  }, [notify])

  const toggleTool = useCallback(async () => {
    if (toolOpenRef.current) { setToolOpen(false); return }
    const path = pathRef.current
    if (path && !(stateRef.current?.path === path && stateRef.current.visible)) await setNoteVisible(path, true)
    setTool('pen')
    setToolOpen(true)
  }, [setNoteVisible])

  const create = useCallback(async (draft: AnnotationDraft, record = true) => {
    const path = pathRef.current
    if (!path) throw new Error('请先打开笔记')
    const tempId = `temp-${crypto.randomUUID()}`
    const now = new Date().toISOString()
    const optimistic: Annotation = { ...draft, id: tempId, notePath: path, createdAt: now, updatedAt: now }
    setState(current => current && current.path === path ? { ...current, items: [...current.items, optimistic] } : current)
    try {
      const saved = await api<Annotation>('/annotations', json('POST', { notePath: path, ...draft }))
      if (pathRef.current !== path || dropped.current.has(tempId)) {
        dropped.current.delete(tempId)
        void api(`/annotations?id=${query(saved.id)}`, { method: 'DELETE' }).catch(() => {})
        setState(current => current ? { ...current, items: current.items.filter(item => item.id !== tempId) } : current)
        return saved
      }
      setState(current => current ? { ...current, items: current.items.map(item => item.id === tempId ? saved : item) } : current)
      if (record) remember({ op: 'create', id: saved.id })
      return saved
    } catch (error) {
      setState(current => current ? { ...current, items: current.items.filter(item => item.id !== tempId) } : current)
      notify((error as Error).message, true)
      throw error
    }
  }, [notify, remember])

  const update = useCallback(async (id: string, comment: string, record = true) => {
    const previous = stateRef.current?.items.find(item => item.id === id)
    if (!previous) return
    setState(current => current ? { ...current, items: current.items.map(item => item.id === id ? { ...item, comment } : item) } : current)
    try {
      const saved = await api<Annotation>('/annotations', json('PUT', { id, comment }))
      setState(current => current ? { ...current, items: current.items.map(item => item.id === id ? saved : item) } : current)
      if (record) remember({ op: 'update', id, comment: previous.comment })
    } catch (error) {
      setState(current => current ? { ...current, items: current.items.map(item => item.id === id ? previous : item) } : current)
      notify((error as Error).message, true)
      throw error
    }
  }, [notify, remember])

  const remove = useCallback(async (id: string, record = true) => {
    if (id.startsWith('temp-')) {
      dropped.current.add(id)
      setState(current => current ? { ...current, items: current.items.filter(item => item.id !== id) } : current)
      return
    }
    const previous = stateRef.current?.items.find(item => item.id === id)
    setState(current => current ? { ...current, items: current.items.filter(item => item.id !== id) } : current)
    try {
      await api(`/annotations?id=${query(id)}`, { method: 'DELETE' })
      if (record && previous) remember({ op: 'remove', item: previous })
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return
      if (previous) setState(current => current ? { ...current, items: current.items.some(item => item.id === id) ? current.items : [...current.items, previous] } : current)
      notify((error as Error).message, true)
      throw error
    }
  }, [notify, remember])

  const removeMany = useCallback(async (ids: string[]) => {
    const items = (stateRef.current?.items || []).filter(item => ids.includes(item.id) && !item.id.startsWith('temp-'))
    if (!items.length) return
    setState(current => current ? { ...current, items: current.items.filter(item => !ids.includes(item.id)) } : current)
    const removed: Annotation[] = []
    try {
      for (const item of items) {
        await api(`/annotations?id=${query(item.id)}`, { method: 'DELETE' })
        removed.push(item)
      }
      if (removed.length) remember({ op: 'remove-many', items: removed })
    } catch (error) {
      const pending = items.filter(item => !removed.some(done => done.id === item.id))
      setState(current => current ? { ...current, items: [...current.items, ...pending] } : current)
      if (removed.length) remember({ op: 'remove-many', items: removed })
      notify((error as Error).message, true)
    }
  }, [notify, remember])

  const undo = useCallback(async () => {
    const entry = undoRef.current.pop()
    setUndoCount(undoRef.current.length)
    if (!entry) return
    if (entry.op === 'create') await remove(entry.id, false)
    else if (entry.op === 'remove') await create({ kind: entry.item.kind, anchorLine: entry.item.anchorLine, anchorText: entry.item.anchorText, color: entry.item.color, data: entry.item.data, comment: entry.item.comment }, false)
    else if (entry.op === 'remove-many') {
      for (const item of entry.items) await create({ kind: item.kind, anchorLine: item.anchorLine, anchorText: item.anchorText, color: item.color, data: item.data, comment: item.comment }, false)
    } else await update(entry.id, entry.comment, false)
  }, [create, remove, update])

  const setStaleIds = useCallback((ids: string[]) => {
    setStaleIdsState(current => current.length === ids.length && current.every((id, index) => id === ids[index]) ? current : ids)
  }, [])

  return {
    state, toolOpen, tool, setTool, color, setColor, strokePixels, setStrokePixels, staleIds, setStaleIds, undoCount,
    closeTool, toggleTool, setNoteVisible, create, update, remove, removeMany, undo,
  }
}

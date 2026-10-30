import { Eraser, Highlighter, MousePointer2, Pencil, Undo2 } from 'lucide-react'
import { annotationColors, annotationStrokePixels } from './anchor'
import type { AnnotationToolName } from './useAnnotations'
import './Annotations.css'

const toolButtons: { id: AnnotationToolName; label: string; icon: typeof Pencil }[] = [
  { id: 'browse', label: '浏览', icon: MousePointer2 },
  { id: 'pen', label: '画笔', icon: Pencil },
  { id: 'highlight', label: '高亮批注', icon: Highlighter },
  { id: 'eraser', label: '橡皮擦', icon: Eraser },
]

export function AnnotationToolbar({ tool, setTool, color, setColor, strokePixels, setStrokePixels, canUndo, onUndo, onDone, staleCount, onClearStale }: {
  tool: AnnotationToolName
  setTool: (tool: AnnotationToolName) => void
  color: string
  setColor: (color: string) => void
  strokePixels: number
  setStrokePixels: (pixels: number) => void
  canUndo: boolean
  onUndo: () => void
  onDone: () => void
  staleCount: number
  onClearStale: () => void
}) {
  const showColors = tool === 'pen' || tool === 'highlight'
  return <div className="annotation-toolbar-anchor">
    <div className="annotation-toolbar" role="toolbar" aria-label="标注工具">
      {toolButtons.map(item => {
        const Icon = item.icon
        return <button key={item.id} type="button" aria-label={item.label} aria-pressed={tool === item.id} onClick={() => setTool(item.id)}><Icon size={15} />{item.label}</button>
      })}
      {showColors && <span className="annotation-swatches" aria-label="标注颜色">{annotationColors.map(value => <button key={value} type="button" className="annotation-swatch" style={{ background: value }} aria-label={`颜色 ${value}`} aria-pressed={color === value} onClick={() => setColor(value)} />)}</span>}
      {tool === 'pen' && <span className="annotation-widths" aria-label="画笔粗细">{annotationStrokePixels.map(value => <button key={value} type="button" aria-label={value === 2 ? '细线' : value === 4 ? '中等' : '粗线'} aria-pressed={strokePixels === value} onClick={() => setStrokePixels(value)}><i style={{ height: value }} /></button>)}</span>}
      {staleCount > 0 && <button type="button" onClick={onClearStale}>清除 {staleCount} 条失效标注</button>}
      <button type="button" aria-label="撤销" disabled={!canUndo} onClick={onUndo}><Undo2 size={15} />撤销</button>
      <button type="button" onClick={onDone}>完成</button>
    </div>
  </div>
}

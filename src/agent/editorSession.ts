import { extractEdits, extractStringField } from './partialJson'
import { findUniqueRange } from './noteEdits'

export type HighlightRange = { from: number; to: number }

export type SessionEditor = {
  getDoc: () => string
  replace: (from: number, to: number, insert: string) => void
  setHighlights: (ranges: HighlightRange[]) => void
  setLocked: (locked: boolean) => void
}

type Slot = { from: number; to: number; written: string; located: boolean; wrote: boolean; failed?: string }

type ToolState = { name: string; edits: Slot[]; region: Slot }

function emptySlot(): Slot {
  return { from: 0, to: 0, written: '', located: false, wrote: false }
}

function mapPoint(pos: number, from: number, to: number, insertLength: number) {
  if (pos < from) return pos
  if (pos >= to) return pos + insertLength - (to - from)
  return from
}

export class NoteAiSession {
  private snapshot = ''
  private active = false
  private readonly tools = new Map<string, ToolState>()

  constructor(private readonly editor: SessionEditor) {}

  begin() {
    if (this.active) return
    this.active = true
    this.snapshot = this.editor.getDoc()
    this.tools.clear()
    this.editor.setLocked(true)
    this.editor.setHighlights([])
  }

  apply(toolId: string, name: string, args: string) {
    if (!this.active) return
    let tool = this.tools.get(toolId)
    if (!tool) {
      tool = { name, edits: [], region: emptySlot() }
      this.tools.set(toolId, tool)
    }
    if (name === 'edit_note') this.applyEdits(tool, args)
    else if (name === 'append_to_note') this.applyAppend(tool, args)
    else if (name === 'rewrite_note') this.applyRewrite(tool, args)
  }

  finish() {
    const failures: string[] = []
    for (const tool of this.tools.values()) {
      if (tool.name !== 'edit_note') {
        if (tool.region.failed) failures.push(tool.region.failed)
        continue
      }
      for (const edit of tool.edits) {
        if (edit.failed) failures.push(edit.failed)
        else if (!edit.located) failures.push('有一处修改尚未完成')
      }
    }
    return { failures: [...new Set(failures)] }
  }

  resolve(action: 'accept' | 'reject') {
    if (!this.active) return
    if (action === 'reject') {
      const doc = this.editor.getDoc()
      if (doc !== this.snapshot) this.editor.replace(0, doc.length, this.snapshot)
    }
    this.editor.setHighlights([])
    this.editor.setLocked(false)
    this.active = false
    this.tools.clear()
  }

  private applyEdits(tool: ToolState, args: string) {
    const parsed = extractEdits(args)
    while (tool.edits.length < parsed.length) tool.edits.push(emptySlot())
    const doc = this.editor.getDoc()
    for (let index = 0; index < parsed.length; index++) {
      const item = parsed[index]
      const slot = tool.edits[index]
      if (slot.located || !item.searchComplete) continue
      const found = findUniqueRange(doc, item.search)
      if ('error' in found) {
        slot.failed = found.error
        slot.located = true
        continue
      }
      if (this.overlaps(found.from, found.to, slot)) {
        slot.failed = '修改范围重叠'
        slot.located = true
        continue
      }
      slot.located = true
      slot.from = found.from
      slot.to = found.to
    }
    for (let index = 0; index < parsed.length; index++) {
      const slot = tool.edits[index]
      if (!slot.located || slot.failed) continue
      if (slot.wrote && parsed[index].replace === slot.written) continue
      this.write(slot, parsed[index].replace)
    }
    this.paint()
  }

  private applyAppend(tool: ToolState, args: string) {
    const field = extractStringField(args, 'text')
    if (!field) return
    this.writeRegion(tool.region, () => {
      const end = this.editor.getDoc().length
      return { from: end, to: end }
    }, field.value)
  }

  private applyRewrite(tool: ToolState, args: string) {
    const field = extractStringField(args, 'content')
    if (!field) return
    this.writeRegion(tool.region, () => ({ from: 0, to: this.editor.getDoc().length }), field.value)
  }

  private writeRegion(slot: Slot, initial: () => { from: number; to: number }, insert: string) {
    if (slot.failed) return
    if (!slot.located) {
      const range = initial()
      slot.located = true
      slot.from = range.from
      slot.to = range.to
    }
    if (slot.wrote && insert === slot.written) return
    this.write(slot, insert)
    this.paint()
  }

  private write(slot: Slot, insert: string) {
    const { from, to } = slot
    const doc = this.editor.getDoc()
    if (from < 0 || to < from || to > doc.length) {
      slot.failed = '修改位置已失效'
      return
    }
    this.editor.replace(from, to, insert)
    for (const other of this.liveSlots()) {
      if (other === slot) continue
      other.from = mapPoint(other.from, from, to, insert.length)
      other.to = mapPoint(other.to, from, to, insert.length)
    }
    slot.from = from
    slot.to = from + insert.length
    slot.written = insert
    slot.wrote = true
  }

  private overlaps(from: number, to: number, self: Slot) {
    return this.liveSlots().some(slot => slot !== self && from < slot.to && slot.from < to)
  }

  private liveSlots() {
    const slots: Slot[] = []
    for (const tool of this.tools.values()) {
      if (tool.name === 'edit_note') slots.push(...tool.edits.filter(slot => slot.located && !slot.failed))
      else if (tool.region.located && !tool.region.failed) slots.push(tool.region)
    }
    return slots
  }

  private paint() {
    const ranges = this.liveSlots()
      .filter(slot => slot.to > slot.from)
      .map(slot => ({ from: slot.from, to: slot.to }))
      .sort((left, right) => left.from - right.from || left.to - right.to)
    const visible: HighlightRange[] = []
    let cursor = 0
    for (const range of ranges) {
      if (range.from < cursor) continue
      visible.push(range)
      cursor = range.to
    }
    this.editor.setHighlights(visible)
  }
}

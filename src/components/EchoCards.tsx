import { Children, isValidElement, useId, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'
import type { EchoCardKind } from '../remarkEchoCards'
import './EchoCards.css'

type Panel = { key: string; title: string; content: ReactNode }

function classList(value: unknown) {
  if (Array.isArray(value)) return value.map(String).join(' ')
  return typeof value === 'string' ? value : ''
}

function attr(props: Record<string, unknown>, name: string) {
  const raw = props[name] ?? props[name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())]
  return raw == null ? '' : String(raw)
}

export function isEchoCardElement(className: unknown) {
  return /\becho-card\b/.test(classList(className)) && !/\becho-card-panel\b/.test(classList(className))
}

export function isEchoCardPanelElement(className: unknown) {
  return /\becho-card-panel\b/.test(classList(className))
}

function readPanels(children: ReactNode): Panel[] {
  const panels: Panel[] = []
  Children.forEach(children, (child, index) => {
    if (!isValidElement(child)) return
    const props = child.props as Record<string, unknown>
    if (!isEchoCardPanelElement(props.className)) return
    panels.push({
      key: `panel-${index}`,
      title: attr(props, 'data-title') || '未命名',
      content: props.children as ReactNode,
    })
  })
  return panels
}

function StaticPanels({ panels, title }: { panels: Panel[]; title?: string }) {
  return <div className="echo-card echo-card--static">
    {title ? <div className="echo-card-title">{title}</div> : null}
    {panels.map(panel => <section key={panel.key} className="echo-card-static-panel">
      <h3 className="echo-card-static-heading">{panel.title}</h3>
      <div className="echo-card-body">{panel.content}</div>
    </section>)}
  </div>
}

function PlainCard({ title, children, exporting }: { title: string; children: ReactNode; exporting: boolean }) {
  return <div className={`echo-card echo-card--card${exporting ? ' echo-card--static' : ''}`}>
    {title ? <div className="echo-card-title">{title}</div> : null}
    <div className="echo-card-body">{children}</div>
  </div>
}

function TabsCard({ panels, vertical, exporting }: { panels: Panel[]; vertical: boolean; exporting: boolean }) {
  const [active, setActive] = useState(0)
  const baseId = useId()
  if (exporting) return <StaticPanels panels={panels} />
  const current = panels[Math.min(active, Math.max(panels.length - 1, 0))]
  return <div className={`echo-card echo-card--tabs${vertical ? ' is-vertical' : ''}`}>
    <div className="echo-card-tabs" role="tablist" aria-orientation={vertical ? 'vertical' : 'horizontal'}>
      {panels.map((panel, index) => <button
        key={panel.key}
        type="button"
        role="tab"
        id={`${baseId}-tab-${index}`}
        aria-selected={index === active}
        aria-controls={`${baseId}-panel-${index}`}
        className={index === active ? 'is-active' : undefined}
        onClick={() => setActive(index)}
      >{panel.title}</button>)}
    </div>
    {current ? <div
      className="echo-card-body"
      role="tabpanel"
      id={`${baseId}-panel-${active}`}
      aria-labelledby={`${baseId}-tab-${active}`}
    >{current.content}</div> : null}
  </div>
}

function AccordionCard({ panels, exporting }: { panels: Panel[]; exporting: boolean }) {
  const [open, setOpen] = useState(() => new Set(panels.length ? [0] : []))
  const baseId = useId()
  if (exporting) return <StaticPanels panels={panels} />
  function toggle(index: number) {
    setOpen(current => {
      const next = new Set(current)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }
  return <div className="echo-card echo-card--accordion">
    {panels.map((panel, index) => {
      const expanded = open.has(index)
      return <div key={panel.key} className={`echo-card-accordion-item${expanded ? ' is-open' : ''}`}>
        <button
          type="button"
          className="echo-card-accordion-trigger"
          aria-expanded={expanded}
          aria-controls={`${baseId}-panel-${index}`}
          id={`${baseId}-trigger-${index}`}
          onClick={() => toggle(index)}
        >
          <span>{panel.title}</span>
          <ChevronDown size={16} strokeWidth={1.7} aria-hidden="true" />
        </button>
        {expanded ? <div
          className="echo-card-body"
          id={`${baseId}-panel-${index}`}
          role="region"
          aria-labelledby={`${baseId}-trigger-${index}`}
        >{panel.content}</div> : null}
      </div>
    })}
  </div>
}

function CarouselCard({ panels, exporting }: { panels: Panel[]; exporting: boolean }) {
  const [active, setActive] = useState(0)
  if (exporting) return <StaticPanels panels={panels} />
  const total = panels.length
  const index = total ? ((active % total) + total) % total : 0
  const current = panels[index]
  return <div className="echo-card echo-card--carousel">
    <div className="echo-card-carousel-toolbar">
      <button type="button" className="icon-button" aria-label="上一页" disabled={total < 2} onClick={() => setActive(value => value - 1)}>
        <ChevronLeft size={16} strokeWidth={1.7} />
      </button>
      <div className="echo-card-carousel-title">{current?.title || '未命名'}</div>
      <button type="button" className="icon-button" aria-label="下一页" disabled={total < 2} onClick={() => setActive(value => value + 1)}>
        <ChevronRight size={16} strokeWidth={1.7} />
      </button>
    </div>
    {current ? <div className="echo-card-body">{current.content}</div> : null}
    {total > 1 ? <div className="echo-card-dots" role="tablist" aria-label="轮播页">
      {panels.map((panel, dot) => <button
        key={panel.key}
        type="button"
        role="tab"
        aria-label={panel.title}
        aria-selected={dot === index}
        className={dot === index ? 'is-active' : undefined}
        onClick={() => setActive(dot)}
      />)}
    </div> : null}
  </div>
}

export function EchoCard({ kind, title, children, exporting = false }: {
  kind: EchoCardKind
  title?: string
  children: ReactNode
  exporting?: boolean
}) {
  if (kind === 'card') return <PlainCard title={title || ''} exporting={exporting}>{children}</PlainCard>
  const panels = readPanels(children)
  if (kind === 'htabs') return <TabsCard panels={panels} vertical={false} exporting={exporting} />
  if (kind === 'vtabs') return <TabsCard panels={panels} vertical exporting={exporting} />
  if (kind === 'accordion') return <AccordionCard panels={panels} exporting={exporting} />
  return <CarouselCard panels={panels} exporting={exporting} />
}

export function echoCardFromDivProps(props: Record<string, unknown>, children: ReactNode, exporting: boolean): ReactElement | null {
  if (!isEchoCardElement(props.className)) return null
  const kind = attr(props, 'data-echo-card') as EchoCardKind
  if (!kind) return null
  return <EchoCard kind={kind} title={attr(props, 'data-title')} exporting={exporting}>{children}</EchoCard>
}

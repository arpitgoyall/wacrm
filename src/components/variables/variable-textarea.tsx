"use client"

import { useRef, useState } from "react"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

export const TEXT_VARIABLES = [
  { value: "contact.name", label: "Contact name" },
  { value: "contact.phone", label: "Contact phone" },
  { value: "contact.email", label: "Contact email" },
  { value: "contact.company", label: "Contact company" },
  { value: "customer_name", label: "Customer name" },
  { value: "counselor_name", label: "Assigned counselor name" },
  { value: "message.text", label: "Latest message" },
] as const

export function VariableTextarea({
  value,
  onChange,
  className,
  rows,
  placeholder,
  maxLength,
}: {
  value: string
  onChange: (value: string) => void
  className?: string
  rows?: number
  placeholder?: string
  maxLength?: number
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const matches = TEXT_VARIABLES.filter((item) => item.value.includes(query.toLowerCase()))

  function update(next: string, cursor: number) {
    onChange(next)
    const before = next.slice(0, cursor)
    const start = before.lastIndexOf("{{")
    const tail = start >= 0 ? before.slice(start + 2) : ""
    const active = start >= 0 && !tail.includes("}}") && /^[\w.]*$/.test(tail)
    setOpen(active)
    setQuery(active ? tail : "")
  }

  function insert(variable: string) {
    const el = ref.current
    const cursor = el?.selectionStart ?? value.length
    const start = value.slice(0, cursor).lastIndexOf("{{")
    if (start < 0) return
    const inserted = `{{${variable}}}`
    const next = value.slice(0, start) + inserted + value.slice(cursor)
    onChange(next)
    setOpen(false)
    requestAnimationFrame(() => {
      const position = start + inserted.length
      el?.focus()
      el?.setSelectionRange(position, position)
    })
  }

  return (
    <div className="relative">
      <Textarea
        ref={ref}
        value={value}
        rows={rows}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(event) => update(event.target.value, event.target.selectionStart)}
        onClick={(event) => update(value, event.currentTarget.selectionStart)}
        className={className}
      />
      {open && matches.length > 0 && (
        <div className="absolute z-50 mt-1 max-h-52 w-full overflow-auto rounded-md border border-border bg-popover p-1 shadow-lg">
          {matches.map((item) => (
            <button
              key={item.value}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => insert(item.value)}
              className={cn("flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs hover:bg-muted")}
            >
              <span>{item.label}</span>
              <code className="text-muted-foreground">{`{{${item.value}}}`}</code>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

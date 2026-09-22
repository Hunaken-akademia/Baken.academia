"use client"

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Tabs as TabsPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

type TabsProps = React.ComponentProps<typeof TabsPrimitive.Root> & {
  onSwipeBack?: () => void
}

function Tabs({
  className,
  style,
  orientation = "horizontal",
  defaultValue,
  value,
  onValueChange,
  onSwipeBack,
  ...props
}: TabsProps) {
  const [internalValue, setInternalValue] = React.useState(defaultValue)
  const root = React.useRef<HTMLDivElement>(null)
  const start = React.useRef<{ x: number; y: number; time: number } | null>(null)
  const suppressClickUntil = React.useRef(0)
  const selected = value ?? internalValue
  const change = (next: string) => {
    setInternalValue(next)
    onValueChange?.(next)
  }
  return (
    <TabsPrimitive.Root
      ref={root}
      style={{ touchAction: orientation === "horizontal" ? "pan-y pinch-zoom" : undefined, ...style }}
      value={selected}
      onValueChange={change}
      onTouchStart={(event) => {
        suppressClickUntil.current = 0
        start.current = null
        const touch = event.touches[0]
        if (orientation !== "horizontal" || event.touches.length !== 1 ||
            touch.clientX < 24 || touch.clientX > window.innerWidth - 24 ||
            (event.target as HTMLElement).closest("input,textarea,select,[data-no-swipe]")) return
        start.current = { x: touch.clientX, y: touch.clientY, time: Date.now() }
      }}
      onTouchMove={(event) => {
        if (!start.current) return
        if (event.touches.length !== 1 || Math.abs(event.touches[0].clientY - start.current.y) > 35) start.current = null
      }}
      onTouchCancel={() => { start.current = null }}
      onTouchEnd={(event) => {
        const origin = start.current
        start.current = null
        if (!origin || !event.changedTouches.length) return
        const dx = event.changedTouches[0].clientX - origin.x
        const dy = event.changedTouches[0].clientY - origin.y
        if (Date.now() - origin.time > 800 || Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 2) return
        const tabs = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)') ?? [])
        const index = tabs.findIndex((tab) => tab.getAttribute("aria-selected") === "true")
        if (index === 0 && dx > 0 && onSwipeBack) {
          event.preventDefault()
          event.stopPropagation()
          suppressClickUntil.current = Date.now() + 400
          onSwipeBack()
          return
        }
        const target = tabs[index + (dx < 0 ? 1 : -1)]
        const next = target?.getAttribute("data-tab-value")
        if (index >= 0 && next) {
          event.preventDefault()
          event.stopPropagation()
          change(next)
          suppressClickUntil.current = Date.now() + 400
        }
      }}
      onClickCapture={(event) => {
        if (event.detail > 0 && Date.now() < suppressClickUntil.current) {
          event.preventDefault()
          event.stopPropagation()
          suppressClickUntil.current = 0
        }
      }}
      data-slot="tabs"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        "group/tabs flex gap-2 data-[orientation=horizontal]:flex-col",
        className
      )}
      {...props}
    />
  )
}

const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit items-center justify-center rounded-lg p-[3px] text-muted-foreground group-data-[orientation=horizontal]/tabs:h-9 group-data-[orientation=vertical]/tabs:h-fit group-data-[orientation=vertical]/tabs:flex-col data-[variant=line]:rounded-none",
  {
    variants: {
      variant: {
        default: "bg-muted",
        line: "gap-1 bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function TabsList({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> &
  VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  )
}

function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      data-tab-value={props.value}
      className={cn(
        "relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-sm font-medium whitespace-nowrap text-foreground/60 transition-all group-data-[orientation=vertical]/tabs:w-full group-data-[orientation=vertical]/tabs:justify-start hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 group-data-[variant=default]/tabs-list:data-[state=active]:shadow-sm group-data-[variant=line]/tabs-list:data-[state=active]:shadow-none dark:text-muted-foreground dark:hover:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-[state=active]:bg-transparent dark:group-data-[variant=line]/tabs-list:data-[state=active]:border-transparent dark:group-data-[variant=line]/tabs-list:data-[state=active]:bg-transparent",
        "data-[state=active]:bg-background data-[state=active]:text-foreground dark:data-[state=active]:border-input dark:data-[state=active]:bg-input/30 dark:data-[state=active]:text-foreground",
        "after:absolute after:bg-foreground after:opacity-0 after:transition-opacity group-data-[orientation=horizontal]/tabs:after:inset-x-0 group-data-[orientation=horizontal]/tabs:after:bottom-[-5px] group-data-[orientation=horizontal]/tabs:after:h-0.5 group-data-[orientation=vertical]/tabs:after:inset-y-0 group-data-[orientation=vertical]/tabs:after:-right-1 group-data-[orientation=vertical]/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-[state=active]:after:opacity-100",
        className
      )}
      {...props}
    />
  )
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("flex-1 outline-none", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants }

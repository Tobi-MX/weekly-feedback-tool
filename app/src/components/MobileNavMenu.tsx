import { useEffect, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { MenuIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { cn } from '@/lib/utils'

export function mobileNavLinkClass(isActive: boolean): string {
  return cn(
    'flex h-10 items-center rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    isActive
      ? 'bg-secondary text-secondary-foreground'
      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
  )
}

const DESKTOP_MEDIA_QUERY = '(min-width: 768px)'

function isDesktopViewport(): boolean {
  return window.matchMedia(DESKTOP_MEDIA_QUERY).matches
}

/**
 * Below the Tailwind `md` breakpoint the primary link lives behind this menu
 * button. The trigger's `aria-controls` target is the persistent wrapper, so it
 * exists in the DOM even while the sheet content is unmounted.
 */
export function MobileNavMenu() {
  const [isDesktop, setIsDesktop] = useState(isDesktopViewport)
  const [open, setOpen] = useState(false)
  const [container, setContainer] = useState<HTMLDivElement | null>(null)

  // At the desktop breakpoint the trigger is hidden. Remove the whole menu so
  // an open sheet cannot stay mounted (and focus-trapped) behind the desktop
  // navigation, and so no duplicate hidden Projects link remains focusable.
  useEffect(() => {
    const desktop = window.matchMedia(DESKTOP_MEDIA_QUERY)
    const handleChange = (event: MediaQueryListEvent) => {
      setIsDesktop(event.matches)
      if (event.matches) {
        setOpen(false)
      }
    }

    desktop.addEventListener('change', handleChange)
    return () => {
      desktop.removeEventListener('change', handleChange)
    }
  }, [])

  if (isDesktop) {
    return null
  }

  return (
    <div
      ref={setContainer}
      id="mobile-navigation"
      className="flex items-center md:hidden"
    >
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Open menu"
            aria-expanded={open}
            aria-controls="mobile-navigation"
          >
            <MenuIcon aria-hidden="true" />
          </Button>
        </SheetTrigger>
        <SheetContent container={container} side="left" className="w-72">
          <SheetHeader>
            <SheetTitle>Navigation</SheetTitle>
            <SheetDescription className="sr-only">
              Main navigation links.
            </SheetDescription>
          </SheetHeader>
          <ul className="flex flex-col gap-1 px-2">
            <li>
              <NavLink
                to="/projects"
                onClick={() => {
                  setOpen(false)
                }}
                className={({ isActive }) => mobileNavLinkClass(isActive)}
              >
                Projects
              </NavLink>
            </li>
          </ul>
        </SheetContent>
      </Sheet>
    </div>
  )
}

export default MobileNavMenu

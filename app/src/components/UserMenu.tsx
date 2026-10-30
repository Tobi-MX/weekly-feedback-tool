import { useState } from 'react'
import { CircleUserRoundIcon } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/auth/AuthProvider'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export interface UserMenuProps {
  /** Profile display name, or the account email while it is unavailable. */
  readonly label: string
  readonly email: string | null
}

/**
 * The single sign-out control in the signed-in UI. The trigger's accessible
 * name always includes the current display label.
 */
export function UserMenu({ label, email }: UserMenuProps) {
  const { signOut, isSigningOut } = useAuth()
  const [pending, setPending] = useState(false)
  const signingOut = pending || isSigningOut

  const handleSignOut = async () => {
    if (signingOut) {
      return
    }

    setPending(true)
    try {
      await signOut()
    } catch {
      // AuthProvider clears the local session even when the request fails.
    }

    toast.success('Signed out')
    setPending(false)
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="max-w-[12rem] gap-2 px-2"
          aria-label={`Account menu for ${label}`}
        >
          <CircleUserRoundIcon aria-hidden="true" />
          <span className="hidden truncate sm:inline">{label}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="font-normal">
          <span className="block truncate text-sm font-medium">{label}</span>
          {email && email !== label ? (
            <span className="block truncate text-xs text-muted-foreground">
              {email}
            </span>
          ) : null}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={signingOut}
          onSelect={(event) => {
            event.preventDefault()
            void handleSignOut()
          }}
        >
          {signingOut ? 'Signing out…' : 'Sign out'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export default UserMenu

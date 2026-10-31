import { useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import type { ProjectMember } from './membersApi'
import { buildInviteUrl } from './membersErrors'
import { formatProjectDate } from './projectDate'
import {
  useCreateInvite,
  useProjectInviteQuery,
  useProjectMembersQuery,
  useRevokeInvite,
  useTransferFacilitator,
} from './useMembers'
import { useProjectQuery } from './useProjects'

const INVITE_ERROR_TOAST = 'Could not update the invite link. Try again.'
const TRANSFER_ERROR_TOAST = 'Could not change the facilitator. Try again.'
const COPY_ERROR_TOAST = 'Could not copy. Select the link and copy it manually.'
const CONFIRM_INVITE_COPY =
  'Anyone with the current link will no longer be able to join.'

const wrapText = 'min-w-0 break-words [overflow-wrap:anywhere]'

function InviteSection({ projectId }: { projectId: string }) {
  const inviteQuery = useProjectInviteQuery(projectId, true)
  const createInvite = useCreateInvite(projectId)
  const revokeInvite = useRevokeInvite(projectId)
  const [confirming, setConfirming] = useState<'rotate' | 'disable' | null>(
    null,
  )
  // React disables buttons only after a re-render, so a synchronous second
  // click is guarded here to keep it to one request.
  const pendingRef = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const invite = inviteQuery.data
  const isPending = createInvite.isPending || revokeInvite.isPending

  const runOnce = (action: () => Promise<unknown>) => {
    if (pendingRef.current) {
      return
    }
    pendingRef.current = true
    void action()
      .then(() => {
        setConfirming(null)
      })
      .catch(() => {
        setConfirming(null)
        toast.error(INVITE_ERROR_TOAST)
      })
      .finally(() => {
        pendingRef.current = false
      })
  }

  const url = invite ? buildInviteUrl(invite.token, window.location.origin) : ''

  const copyLink = async () => {
    try {
      if (typeof navigator.clipboard?.writeText !== 'function') {
        throw new Error('Clipboard unavailable')
      }
      await navigator.clipboard.writeText(url)
      toast.success('Invite link copied.')
    } catch {
      toast.error(COPY_ERROR_TOAST)
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }

  return (
    <section
      aria-labelledby="invite-heading"
      className="min-w-0 space-y-3 rounded-lg border bg-card p-4 text-card-foreground"
    >
      <h2 id="invite-heading" className="text-lg font-semibold">
        Invite link
      </h2>

      {inviteQuery.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading invite link…
        </p>
      ) : null}

      {inviteQuery.isError ? (
        <div role="alert" className="space-y-3">
          <p className="text-sm">Could not load the invite link.</p>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              void inviteQuery.refetch()
            }}
          >
            Retry
          </Button>
        </div>
      ) : null}

      {inviteQuery.isSuccess && invite === null ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">No invite link yet.</p>
          <Button
            type="button"
            disabled={isPending}
            onClick={() => {
              runOnce(() => createInvite.mutateAsync())
            }}
          >
            Create invite link
          </Button>
        </div>
      ) : null}

      {inviteQuery.isSuccess && invite ? (
        <div className="min-w-0 space-y-3">
          {invite.status === 'active' ? (
            <>
              <label htmlFor="invite-url" className="block text-sm font-medium">
                Share this link
              </label>
              <input
                id="invite-url"
                ref={inputRef}
                type="text"
                readOnly
                value={url}
                onFocus={(event) => {
                  event.currentTarget.select()
                }}
                className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              />
              <p className="text-sm text-muted-foreground">
                Expires {formatProjectDate(invite.expiresAt)}
              </p>
            </>
          ) : null}
          {invite.status === 'expired' ? (
            <p className="text-sm">This invite link has expired.</p>
          ) : null}
          {invite.status === 'revoked' ? (
            <p className="text-sm">This invite link is disabled.</p>
          ) : null}

          {confirming === null ? (
            <div className="flex flex-wrap gap-2">
              {invite.status === 'active' ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    void copyLink()
                  }}
                >
                  Copy link
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                disabled={isPending}
                onClick={() => {
                  setConfirming('rotate')
                }}
              >
                Create new link
              </Button>
              {invite.status === 'active' ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={isPending}
                  onClick={() => {
                    setConfirming('disable')
                  }}
                >
                  Disable link
                </Button>
              ) : null}
            </div>
          ) : (
            <div
              role="group"
              aria-label={
                confirming === 'rotate'
                  ? 'Confirm new invite link'
                  : 'Confirm disabling the invite link'
              }
              className="space-y-3 rounded-md border border-dashed p-3"
            >
              <p className="text-sm">{CONFIRM_INVITE_COPY}</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant={confirming === 'disable' ? 'destructive' : 'default'}
                  disabled={isPending}
                  onClick={() => {
                    runOnce(() =>
                      confirming === 'rotate'
                        ? createInvite.mutateAsync()
                        : revokeInvite.mutateAsync(),
                    )
                  }}
                >
                  {confirming === 'rotate'
                    ? 'Yes, create new link'
                    : 'Yes, disable link'}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={isPending}
                  onClick={() => {
                    setConfirming(null)
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </section>
  )
}

interface MemberRowProps {
  readonly member: ProjectMember
  readonly canTransfer: boolean
  readonly isConfirming: boolean
  readonly isPending: boolean
  readonly onStartConfirm: () => void
  readonly onCancel: () => void
  readonly onConfirm: () => void
}

function MemberRow({
  member,
  canTransfer,
  isConfirming,
  isPending,
  onStartConfirm,
  onCancel,
  onConfirm,
}: MemberRowProps) {
  const showTransfer = canTransfer && member.role !== 'facilitator'

  return (
    <li className="min-w-0 space-y-2 px-4 py-3">
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className={`font-medium ${wrapText}`}>
            {member.displayName}
          </span>
          {member.isMe ? (
            <span className="text-sm text-muted-foreground">(you)</span>
          ) : null}
          <span className="text-sm text-muted-foreground">
            {member.role === 'facilitator' ? 'Facilitator' : 'Member'}
          </span>
          {member.isOwner ? (
            <span className="rounded-full border px-2 text-xs font-medium">
              Owner
            </span>
          ) : null}
        </div>
        {showTransfer && !isConfirming ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isPending}
            onClick={onStartConfirm}
          >
            Make facilitator
          </Button>
        ) : null}
      </div>
      {showTransfer && isConfirming ? (
        <div
          role="group"
          aria-label="Confirm facilitator change"
          className="space-y-2 rounded-md border border-dashed p-3"
        >
          <p className={`text-sm ${wrapText}`}>
            Make {member.displayName} the facilitator?
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              disabled={isPending}
              onClick={onConfirm}
            >
              Confirm
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={isPending}
              onClick={onCancel}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  )
}

export function ProjectMembersPage() {
  const { id } = useParams<{ id: string }>()
  const projectId = id ?? ''
  const projectQuery = useProjectQuery(id)
  const membersQuery = useProjectMembersQuery(id)
  const transfer = useTransferFacilitator(projectId)
  const [confirmingUserId, setConfirmingUserId] = useState<string | null>(null)
  const transferringRef = useRef(false)

  const project = projectQuery.data
  const members = membersQuery.data
  const isNotFound =
    (projectQuery.isSuccess && project === null) ||
    (membersQuery.isSuccess && members === null)
  const isError = !isNotFound && (projectQuery.isError || membersQuery.isError)
  const isLoading =
    !isNotFound &&
    !isError &&
    (projectQuery.isPending || membersQuery.isPending)
  const isOwner = members?.some((member) => member.isMe && member.isOwner)

  const confirmTransfer = (targetUserId: string) => {
    if (transferringRef.current) {
      return
    }
    transferringRef.current = true
    transfer
      .mutateAsync(targetUserId)
      .then(() => {
        setConfirmingUserId(null)
      })
      .catch(() => {
        toast.error(TRANSFER_ERROR_TOAST)
      })
      .finally(() => {
        transferringRef.current = false
      })
  }

  return (
    <section className="min-w-0 space-y-6">
      {isLoading ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading members…
        </p>
      ) : null}

      {isError ? (
        <div
          role="alert"
          className="space-y-3 rounded-lg border border-destructive/30 bg-card p-4 text-card-foreground"
        >
          <p className="text-sm">Could not load the members.</p>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              if (projectQuery.isError) {
                void projectQuery.refetch()
              }
              if (membersQuery.isError) {
                void membersQuery.refetch()
              }
            }}
          >
            Retry
          </Button>
        </div>
      ) : null}

      {isNotFound ? (
        <div className="space-y-3 rounded-lg border border-dashed bg-card p-6 text-card-foreground">
          <p className="text-sm">
            Project not found or you do not have access.
          </p>
          <Link
            to="/projects"
            className="text-sm font-medium underline underline-offset-4"
          >
            Back to projects
          </Link>
        </div>
      ) : null}

      {!isNotFound && project && members ? (
        <>
          <div className="min-w-0 space-y-2">
            <h1 className={`text-2xl font-semibold tracking-tight ${wrapText}`}>
              {project.name}
            </h1>
            <Link
              to={`/projects/${project.id}`}
              className="text-sm font-medium underline underline-offset-4"
            >
              Back to project
            </Link>
          </div>

          <section aria-labelledby="members-heading" className="space-y-3">
            <h2 id="members-heading" className="text-lg font-semibold">
              Members
            </h2>
            <ul
              aria-label="Members"
              className="divide-y rounded-lg border bg-card text-card-foreground"
            >
              {members.map((member) => (
                <MemberRow
                  key={member.userId}
                  member={member}
                  canTransfer={isOwner === true}
                  isConfirming={confirmingUserId === member.userId}
                  isPending={transfer.isPending}
                  onStartConfirm={() => {
                    setConfirmingUserId(member.userId)
                  }}
                  onCancel={() => {
                    setConfirmingUserId(null)
                  }}
                  onConfirm={() => {
                    confirmTransfer(member.userId)
                  }}
                />
              ))}
            </ul>
          </section>

          {isOwner ? <InviteSection projectId={project.id} /> : null}
        </>
      ) : null}
    </section>
  )
}

export default ProjectMembersPage

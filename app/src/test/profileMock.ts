import { vi } from 'vitest'

/**
 * Shared mock for `src/profile/profileApi.ts`. Every test gets it through
 * `setupTests`, so no test opens a network connection for profile data.
 */
export const profileMock = {
  fetchProfileDisplayName: vi.fn<(userId: string) => Promise<string | null>>(),

  resetProfileMock(): void {
    profileMock.fetchProfileDisplayName.mockReset().mockResolvedValue(null)
  },
}

export function resetProfileMock(): void {
  profileMock.resetProfileMock()
}

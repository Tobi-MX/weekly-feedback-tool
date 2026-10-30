import { QueryClient } from '@tanstack/react-query'

/**
 * The single QueryClient instance used by the application. Tests import it
 * only to inspect or reset the cache; they never create another one.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
})

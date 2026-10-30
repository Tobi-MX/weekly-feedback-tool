export interface PlaceholderPageProps {
  readonly title: string
}

/**
 * An intentionally inert signed-in screen. It has no data queries, actions,
 * fake content, or route-id handling.
 */
export function PlaceholderPage({ title }: PlaceholderPageProps) {
  return (
    <section
      aria-labelledby="page-heading"
      className="rounded-lg border border-dashed bg-card p-6 text-card-foreground"
    >
      <h1 id="page-heading" className="text-2xl font-semibold tracking-tight">
        {title}
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        This screen is not built yet.
      </p>
    </section>
  )
}

export default PlaceholderPage

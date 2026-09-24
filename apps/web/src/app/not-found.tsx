import { ButtonLink } from "@/components/ui";

export default function NotFound() {
  return (
    <main className="mx-auto grid min-h-dvh max-w-md place-items-center px-4 text-center">
      <div>
        <h1 className="text-2xl font-semibold">Not found</h1>
        <p className="mt-2 text-sm text-muted">There is no page — or no deployment — by that name.</p>
        <div className="mt-6"><ButtonLink href="/app">Back to deployments</ButtonLink></div>
      </div>
    </main>
  );
}

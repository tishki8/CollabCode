import Link from "next/link";
import { shareTokenSchema, type LinkPreview } from "@collabcode/shared";
import { serverApiPost } from "@/lib/api";
import { getCurrentUser } from "@/lib/current-user";
import { JoinFlow } from "@/components/JoinFlow";

function Message({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main id="main" className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-3 p-6">
      <h1 className="text-2xl font-bold" data-testid="join-title">{title}</h1>
      <p role="alert" data-testid="join-message">{children}</p>
      <Link href="/" className="underline">Back to CollabCode</Link>
    </main>
  );
}

export default async function JoinPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!shareTokenSchema.safeParse(token).success) {
    return <Message title="Invalid link">This link is not valid.</Message>;
  }

  // Ask the API what the link grants (and whether it still works) BEFORE asking for anything,
  // so an expired link gets a clear message instead of a name form that goes nowhere.
  const preview = await serverApiPost<LinkPreview>("/share-links/preview", { token });
  if (!preview.data) {
    if (preview.error?.code === "LINK_EXPIRED") {
      return <Message title="This link has expired">Share links stop working after the time the owner set. Ask the project owner to send you a new one.</Message>;
    }
    if (preview.status === 404) {
      return <Message title="Link not available">This link is invalid or has been revoked by the project owner.</Message>;
    }
    return <Message title="Something went wrong">We could not check this link right now. Please try again in a moment.</Message>;
  }

  const me = await getCurrentUser();
  return <JoinFlow token={token} preview={preview.data} hasIdentity={me !== null} />;
}

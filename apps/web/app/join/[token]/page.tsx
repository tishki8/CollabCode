import { redirect } from "next/navigation";
import { shareTokenSchema } from "@collabcode/shared";
import { auth } from "@/auth";
import { JoinProject } from "@/components/JoinProject";

export default async function JoinPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!shareTokenSchema.safeParse(token).success) {
    return (
      <main id="main" className="mx-auto max-w-md p-6">
        <p role="alert">This link is not valid.</p>
      </main>
    );
  }
  const session = await auth();
  // Not signed in: sign in first, then come straight back to this link.
  if (!session?.user) redirect(`/?callbackUrl=${encodeURIComponent(`/join/${token}`)}`);
  return <JoinProject token={token} />;
}

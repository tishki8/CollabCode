import { auth } from "@/auth";
import type { MeDto } from "@collabcode/shared";
import { serverApi } from "./api";

/**
 * The visitor, whether they signed in with an account (Auth.js) or joined as a guest (cookie).
 * The API is the single authority on guests, so we ask it instead of re-implementing the lookup.
 */
export async function getCurrentUser(): Promise<MeDto | null> {
  const session = await auth();
  if (session?.user?.id) {
    return { id: session.user.id, name: session.user.name ?? "You", isGuest: false };
  }
  const me = await serverApi<MeDto>("/me");
  return me.data;
}

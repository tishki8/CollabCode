import { readableTextColor, safeColor, type PersonDto } from "@collabcode/shared";

/** A person: coloured initials badge, full name and a "guest" tag. Never colour alone. */
export function PersonChip({ person }: { person: Pick<PersonDto, "name" | "initials" | "color" | "isGuest"> }) {
  const bg = safeColor(person.color);
  return (
    <span className="inline-flex items-center gap-1.5" data-testid="person-chip">
      <span
        aria-hidden="true"
        className="inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-bold"
        style={{ backgroundColor: bg, color: readableTextColor(bg) }}
      >
        {person.initials}
      </span>
      <span>{person.name}</span>
      {person.isGuest && <span className="rounded border border-slate-400 px-1 text-[10px]">guest</span>}
    </span>
  );
}

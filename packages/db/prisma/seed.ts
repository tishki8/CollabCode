// Idempotent seed: two demo users and one demo project. The app can be tried without
// configuring OAuth through /api/dev-login in apps/web (only when DEV_LOGIN=true), which
// creates a session for these users on demand. Never run this against production.
import { PrismaClient } from "@prisma/client";
import { AUTHOR_PALETTE, DEV_USER_EMAILS, initialsOf } from "@collabcode/shared";

const prisma = new PrismaClient();

const DEMO_USERS = [
  { key: "alice", name: "Alice Demo", email: DEV_USER_EMAILS.alice!, githubLogin: "alice-demo" },
  { key: "bob", name: "Bob Demo", email: DEV_USER_EMAILS.bob!, githubLogin: "bob-demo" },
] as const;

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed demo data in production");

  // Earlier versions seeded sessions with fixed, publicly known tokens. Remove them.
  await prisma.session.deleteMany({ where: { sessionToken: { in: ["dev-session-token-alice", "dev-session-token-bob"] } } });

  const users: Record<string, string> = {};
  for (const u of DEMO_USERS) {
    const user = await prisma.user.upsert({
      where: { email: u.email },
      update: { name: u.name },
      create: { name: u.name, email: u.email, githubLogin: u.githubLogin },
    });
    users[u.key] = user.id;
  }

  const DEMO_ID = "demo-project";
  const project = await prisma.project.upsert({
    where: { id: DEMO_ID },
    update: {},
    create: { id: DEMO_ID, name: "Demo: Hello CollabCode", language: "PYTHON", ownerId: users.alice! },
  });

  // Alice owns the project, Bob is an editor. Colours come from the shared palette.
  const members = [
    { userId: users.alice!, role: "OWNER" as const, color: AUTHOR_PALETTE[0], name: "Alice Demo" },
    { userId: users.bob!, role: "EDITOR" as const, color: AUTHOR_PALETTE[1], name: "Bob Demo" },
  ];
  for (const m of members) {
    await prisma.projectMember.upsert({
      where: { projectId_userId: { projectId: project.id, userId: m.userId } },
      update: {},
      create: {
        projectId: project.id,
        userId: m.userId,
        role: m.role,
        color: m.color,
        initials: initialsOf(m.name),
      },
    });
  }

  // File tree: main.py, utils/helpers.py, README.md (only if the project has no files yet)
  if ((await prisma.fileNode.count({ where: { projectId: project.id } })) === 0) {
    const folder = await prisma.fileNode.create({
      data: { projectId: project.id, parentId: null, name: "utils", type: "FOLDER" },
    });
    await prisma.fileNode.createMany({
      data: [
        { projectId: project.id, parentId: null, name: "main.py", type: "FILE" },
        { projectId: project.id, parentId: null, name: "README.md", type: "FILE" },
        { projectId: project.id, parentId: folder.id, name: "helpers.py", type: "FILE" },
      ],
    });
  }

  console.log("Seeded: alice@example.com (owner), bob@example.com (editor), project", project.id);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

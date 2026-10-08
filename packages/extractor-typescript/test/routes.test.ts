import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildOntology, ProjectModel, type FrontendManifest, type TacetConfig } from "@tacet-api/core";
import { extractTypeScriptManifest } from "../src/index.js";
import { nextRoute, remixRoute } from "../src/routes.js";

const fixtures = fileURLToPath(new URL("../../../test/fixtures/", import.meta.url));

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tacet-routes-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function extract(files: Record<string, string>, config: TacetConfig = {}): FrontendManifest {
  const root = mkdtempSync(join(dir, "case-"));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  return extractTypeScriptManifest(root, config);
}

const routes = (m: FrontendManifest) =>
  (m.routes ?? []).map((r) => ({ path: r.path, component: r.component, source: r.source, componentFile: r.componentId?.split(":")[1] }));

describe("route extraction", () => {
  it("reads nested <Route> elements, index routes and the innermost component of an element", () => {
    const m = extract({
      "src/pages/Home.tsx": "export default function Home() { return <div />; }",
      "src/App.tsx": `import { lazy } from "react";
import { Routes, Route } from "react-router-dom";
const Home = lazy(() => import("./pages/Home"));
function RequireAuth({ children }: any) { return <div>{children}</div>; }
function Layout() { return <main />; }
function UserPage() { return <p />; }
export function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="users/:id" element={<RequireAuth><UserPage /></RequireAuth>} />
      </Route>
    </Routes>
  );
}`,
    });
    expect(routes(m)).toEqual([
      { path: "/", component: "Layout", source: "react-router", componentFile: "src/App.tsx" },
      { path: "/", component: "Home", source: "react-router", componentFile: "src/pages/Home.tsx" },
      { path: "/users/:id", component: "UserPage", source: "react-router", componentFile: "src/App.tsx" },
    ]);
  });

  it("reads route objects with children, Component and lazy modules", () => {
    const m = extract({
      "src/pages/Orders.tsx": "export function Component() { return <div />; }",
      "src/router.tsx": `import { createBrowserRouter } from "react-router-dom";
function Admin() { return <main />; }
function Dashboard() { return <p />; }
export const router = createBrowserRouter([
  { path: "/admin", element: <Admin />, children: [
    { index: true, Component: Dashboard },
    { path: "orders", lazy: () => import("./pages/Orders") },
  ] },
]);`,
    });
    expect(routes(m).map((r) => [r.path, r.component])).toEqual([
      ["/admin", "Admin"],
      ["/admin", "Dashboard"],
      ["/admin/orders", "Orders"],
    ]);
  });

  it("reads vue-router routes spread from other files, and links pages to the APIs their components use", () => {
    const m = extract({
      "src/api.ts": `import axios from "axios";
export const getUsers = () => axios.get("/users");
export const getUser = (id: string) => axios.get(\`/users/\${id}\`);`,
      "src/pages/users/index.ts": `import type { RouteRecordRaw } from "vue-router";
export const userRoutes: Array<RouteRecordRaw> = [
  { path: "users", name: "UserList", component: () => import("./ui/UserListPage.vue") },
  { path: "users/:id", component: () => import("./ui/UserDetailPage.vue") },
];`,
      "src/pages/index.ts": `import { userRoutes } from "./users";
import RootLayout from "../RootLayout.vue";
export const routes = [
  { path: "/admin", component: RootLayout, redirect: "/admin/users", children: [...userRoutes] },
];`,
      "src/RootLayout.vue": `<template><router-view /></template>`,
      "src/pages/users/ui/UserListPage.vue": `<script setup lang="ts">
import { ref } from "vue";
import { getUsers } from "../../../api";
import UserTable from "./UserTable.vue";
const users = ref();
getUsers().then((res) => { users.value = res.data; });
</script>
<template>
  <UserTable :rows="users" />
</template>`,
      "src/pages/users/ui/UserTable.vue": `<script setup lang="ts">
defineProps<{ rows: { name: string }[] }>();
</script>
<template>
  <tr v-for="row in rows" :key="row.name"><td>{{ row.name }}</td></tr>
</template>`,
      "src/pages/users/ui/UserDetailPage.vue": `<script setup lang="ts">
import { getUser } from "../../../api";
async function load(id: string) { const { data } = await getUser(id); return data.email; }
</script>
<template><div /></template>`,
    });
    expect(routes(m)).toEqual([
      { path: "/admin", component: "RootLayout", source: "vue-router", componentFile: "src/RootLayout.vue" },
      { path: "/admin/users", component: "UserListPage", source: "vue-router", componentFile: "src/pages/users/ui/UserListPage.vue" },
      { path: "/admin/users/:id", component: "UserDetailPage", source: "vue-router", componentFile: "src/pages/users/ui/UserDetailPage.vue" },
    ]);

    const ontology = buildOntology(new ProjectModel(m, null));
    const pages = Object.fromEntries(
      ontology.pages.map((p) => [p.route, p.apis.map((a) => `${a.apiKey} ${a.fields.join(",")}`.trim())]),
    );
    expect(pages["/admin/users"]).toEqual(["GET /users [].name"]);
    expect(pages["/admin/users/:id"]).toEqual(["GET /users/{param} email"]);
  });

  it("maps Next.js pages/ and app/ files to routes", () => {
    const m = extract({
      "package.json": JSON.stringify({ dependencies: { next: "15" } }),
      "pages/index.tsx": "export default function Index() { return <div />; }",
      "pages/users/[id].tsx": "export default function UserDetail() { return <div />; }",
      "pages/_app.tsx": "export default function App() { return <div />; }",
      "pages/api/users.ts": "export default function handler() { return 1; }",
      "app/(shop)/cart/page.tsx": "const Cart = () => <div />; export default Cart;",
    });
    expect(routes(m).map((r) => [r.path, r.component, r.source])).toEqual([
      ["/", "Index", "file-system"],
      ["/cart", "Cart", "file-system"],
      ["/users/[id]", "UserDetail", "file-system"],
    ]);
  });

  it("converts file names to route paths", () => {
    expect(nextRoute("src/pages/blog/index.tsx")).toBe("/blog");
    expect(nextRoute("app/page.tsx")).toBe("/");
    expect(nextRoute("app/@modal/(group)/photos/[id]/page.tsx")).toBe("/photos/[id]");
    expect(nextRoute("src/components/Button.tsx")).toBeNull();
    expect(remixRoute("app/routes/_index.tsx")).toBe("/");
    expect(remixRoute("app/routes/users.$id.tsx")).toBe("/users/:id");
    expect(remixRoute("app/routes/_auth.login.tsx")).toBe("/login");
    expect(remixRoute("app/routes/files.$.tsx")).toBe("/files/*");
    expect(remixRoute("app/routes/settings/route.tsx")).toBe("/settings");
  });

  it("takes routes from tacet.config.json", () => {
    const m = extract(
      {
        "src/screens/Profile.tsx": "export function Profile() { return <div />; }\nexport function Helper() { return <i />; }",
      },
      { routes: { "/me": "src/screens/Profile.tsx#Profile" } },
    );
    expect(routes(m)).toEqual([{ path: "/me", component: "Profile", source: "config", componentFile: "src/screens/Profile.tsx" }]);
  });

  it("falls back to exported components in page directories when no router is found", () => {
    const m = extractTypeScriptManifest(join(fixtures, "frontend"));
    expect(routes(m)).toEqual([
      { path: null, component: "UserPage", source: "convention", componentFile: "src/pages/User.tsx" },
      { path: null, component: "UserList", source: "convention", componentFile: "src/pages/UserList.tsx" },
    ]);
  });

  it("records resolved calls, rendered components and enclosing functions", () => {
    const m = extractTypeScriptManifest(join(fixtures, "frontend"));
    const byName = (name: string) => m.functions.find((f) => f.name === name)!;
    expect(byName("UserPage").renders).toEqual([byName("UserCard").id]);
    expect(byName("loadProfile").invokes).toEqual(expect.arrayContaining([byName("getUser").id, byName("userApi.getUser").id]));
    const effect = m.functions.find((f) => f.file === "src/pages/User.tsx" && f.location.line === 10)!;
    expect(effect.parentId).toBe(byName("UserPage").id);
    expect(effect.invokes).toEqual([byName("getUser").id]);
  });
});

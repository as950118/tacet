import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FrontendManifest, PropertyAccessInfo, TacetConfig } from "@tacet-api/core";
import { loadConfig } from "@tacet-api/core";
import { cpSync, readFileSync } from "node:fs";
import { extractTypeScriptManifest, TypeScriptProject } from "../src/index.js";

const fixtures = fileURLToPath(new URL("../../../test/fixtures/", import.meta.url));

function accessesAt(m: FrontendManifest, file: string, line: number): PropertyAccessInfo[] {
  return m.propertyAccesses.filter((a) => a.file === file && a.location.line === line);
}

function callAt(m: FrontendManifest, file: string, line: number) {
  const call = m.apiCalls.find((c) => c.file === file && c.location.line === line);
  if (!call) throw new Error(`no api call at ${file}:${line}`);
  return call;
}

describe("extractTypeScriptManifest (fixture frontend)", () => {
  let manifest: FrontendManifest;

  beforeAll(() => {
    manifest = extractTypeScriptManifest(
      join(fixtures, "frontend"),
      loadConfig(join(fixtures, "tacet.config.json")),
    );
  });

  it("collects files with imports and exports", () => {
    const page = manifest.files.find((f) => f.path === "src/pages/User.tsx");
    expect(page?.exports).toEqual(expect.arrayContaining(["UserPage", "loadProfile"]));
    expect(page?.imports).toContainEqual(
      expect.objectContaining({
        source: "../api/user",
        resolvedFile: "src/api/user.ts",
        specifiers: ["getUser", "userApi"],
      }),
    );
    expect(page?.imports).toContainEqual(expect.objectContaining({ source: "react", resolvedFile: null }));
  });

  it("collects functions and marks React components", () => {
    const userPage = manifest.functions.find((f) => f.name === "UserPage");
    expect(userPage).toMatchObject({
      file: "src/pages/User.tsx",
      containingComponent: "UserPage",
      params: [{ name: "{ id }", type: "{ id: number }" }],
    });
    expect(manifest.functions.find((f) => f.name === "getUser")).toMatchObject({
      returnType: "Promise<UserResponse>",
      containingComponent: null,
      calls: ["axios.get"],
    });
  });

  describe("API calls", () => {
    it("resolves axios calls with template literal and string concatenation URLs", () => {
      expect(callAt(manifest, "src/api/user.ts", 6)).toMatchObject({
        method: "GET",
        endpointPattern: "/users/{param}",
        resolution: "direct",
      });
      expect(callAt(manifest, "src/api/user.ts", 11)).toMatchObject({
        method: "GET",
        endpointPattern: "/users/{param}",
        code: 'axios.get<UserResponse>("/users/" + id)',
      });
    });

    it("resolves axios.create() instances imported from another module", () => {
      expect(callAt(manifest, "src/api/user.ts", 12)).toMatchObject({
        method: "PUT",
        endpointPattern: "/users/{param}",
        calleeExpression: "api.put",
      });
    });

    it("resolves fetch with and without an explicit method", () => {
      expect(callAt(manifest, "src/api/user.ts", 16)).toMatchObject({
        method: "GET",
        endpointPattern: "/users",
      });
      expect(callAt(manifest, "src/api/user.ts", 21)).toMatchObject({
        method: "DELETE",
        endpointPattern: "/users/{param}",
      });
    });

    it("infers wrapper functions and API client objects without configuration", () => {
      expect(callAt(manifest, "src/pages/User.tsx", 26)).toMatchObject({
        calleeExpression: "getUser",
        resolution: "wrapper",
        method: "GET",
        endpointPattern: "/users/{param}",
      });
      expect(callAt(manifest, "src/pages/User.tsx", 27)).toMatchObject({
        calleeExpression: "userApi.getUser",
        resolution: "wrapper",
        endpointPattern: "/users/{param}",
      });
    });

    it("uses apiClientMap for clients whose endpoint cannot be inferred", () => {
      expect(callAt(manifest, "src/pages/Product.tsx", 4)).toMatchObject({
        calleeExpression: "productApi.getProduct",
        resolution: "config",
        method: "GET",
        endpointPattern: "/products/{param}",
      });
    });

    it("records which API client function a wrapper call goes through", () => {
      const call = callAt(manifest, "src/pages/User.tsx", 27);
      const wrapper = manifest.functions.find((f) => f.id === call.wrapperFunctionId);
      expect(wrapper).toMatchObject({ name: "userApi.getUser", file: "src/api/user.ts" });
      expect(callAt(manifest, "src/api/user.ts", 6).wrapperFunctionId).toBeNull();
    });

    it("captures statically known query and body keys", () => {
      expect(callAt(manifest, "src/pages/UserAdmin.tsx", 18).request).toEqual({
        queryKeys: ["keyword", "size", "limit"],
        bodyKeys: [],
      });
      expect(callAt(manifest, "src/pages/UserAdmin.tsx", 14).request).toEqual({
        queryKeys: [],
        bodyKeys: ["name", "age", "nickname"],
      });
      expect(callAt(manifest, "src/api/user.ts", 12).request.bodyKeys).toBeNull();
      expect(callAt(manifest, "src/pages/User.tsx", 26).request).toEqual({ queryKeys: null, bodyKeys: null });
    });

    it("records the calling function", () => {
      const call = callAt(manifest, "src/pages/User.tsx", 26);
      const caller = manifest.functions.find((f) => f.id === call.callerFunctionId);
      expect(caller?.name).toBe("loadProfile");
    });
  });

  describe("property accesses", () => {
    it("tracks user.name in JSX through useState + .then(setUser)", () => {
      const call = callAt(manifest, "src/pages/User.tsx", 11);
      expect(accessesAt(manifest, "src/pages/User.tsx", 18)).toEqual([
        expect.objectContaining({
          apiCallId: call.id,
          object: "user",
          path: ["name"],
          flow: "direct",
          code: "user.name",
          containingComponent: "UserPage",
        }),
      ]);
    });

    it("tracks destructuring: const { name } = await getUser(id)", () => {
      expect(accessesAt(manifest, "src/pages/User.tsx", 26)).toEqual([
        expect.objectContaining({ path: ["name"], flow: "direct" }),
      ]);
    });

    it("tracks optional chaining and nested paths: user?.profile.email", () => {
      expect(accessesAt(manifest, "src/pages/User.tsx", 28)).toEqual([
        expect.objectContaining({ path: ["profile", "email"], code: "user?.profile.email" }),
      ]);
    });

    it("marks values passed through unknown functions as derived", () => {
      expect(accessesAt(manifest, "src/pages/User.tsx", 30)).toEqual([
        expect.objectContaining({ object: "value", path: ["name"], flow: "derived" }),
      ]);
    });

    it("follows values passed as JSX props into child components", () => {
      const call = callAt(manifest, "src/pages/User.tsx", 11);
      expect(accessesAt(manifest, "src/components/UserCard.tsx", 4)).toEqual([
        expect.objectContaining({
          apiCallId: call.id,
          path: ["name"],
          containingComponent: "UserCard",
        }),
      ]);
    });

    it("tracks array elements of list responses via useQuery + .map", () => {
      const paths = accessesAt(manifest, "src/pages/UserList.tsx", 9).map((a) => a.path);
      expect(paths).toEqual([
        ["[]", "name"],
        ["[]", "age"],
      ]);
    });

    it("links every access to an indexed API call", () => {
      const ids = new Set(manifest.apiCalls.map((c) => c.id));
      expect(manifest.propertyAccesses.every((a) => ids.has(a.apiCallId))).toBe(true);
    });
  });
});

describe("TypeScriptProject.refresh", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "tacet-refresh-"));
    cpSync(join(fixtures, "frontend"), dir, { recursive: true });
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("picks up edited, added and deleted files without reloading the project", () => {
    const project = TypeScriptProject.load(dir);
    const before = project.extract();

    const card = join(dir, "src/components/UserCard.tsx");
    writeFileSync(card, readFileSync(card, "utf8").replace("user.name.toUpperCase()", "user.username"));
    writeFileSync(
      join(dir, "src/pages/New.tsx"),
      `import axios from "axios";\nexport const load = () => axios.get("/new").then((r) => r.data.value);\n`,
    );
    rmSync(join(dir, "src/pages/Product.tsx"));
    project.refresh(["src/components/UserCard.tsx", "src/pages/New.tsx", "src/pages/Product.tsx"]);

    const after = project.extract();
    expect(accessesAt(after, "src/components/UserCard.tsx", 4).map((a) => a.path)).toEqual([["username"]]);
    expect(after.apiCalls.some((c) => c.endpointPattern === "/new")).toBe(true);
    expect(after.files.some((f) => f.path === "src/pages/Product.tsx")).toBe(false);
    expect(after.files.length).toBe(before.files.length);
  });

  it("regenerates and removes Vue components", () => {
    const vue = join(dir, "src/pages/Orders.vue");
    const component = (field: string) =>
      `<script setup lang="ts">\nimport axios from "axios";\nconst load = () => axios.get("/orders").then((r) => r.data.${field});\n</script>\n`;
    writeFileSync(vue, component("total"));
    const project = TypeScriptProject.load(dir);
    expect(accessesAt(project.extract(), "src/pages/Orders.vue", 3).map((a) => a.path)).toEqual([["total"]]);

    writeFileSync(vue, component("count"));
    project.refresh(["src/pages/Orders.vue"]);
    expect(accessesAt(project.extract(), "src/pages/Orders.vue", 3).map((a) => a.path)).toEqual([["count"]]);

    rmSync(vue);
    project.refresh(["src/pages/Orders.vue"]);
    expect(project.extract().files.some((f) => f.path === "src/pages/Orders.vue")).toBe(false);
  });
});

describe("extractTypeScriptManifest (edge cases)", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "tacet-ts-"));
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

  it("works without a tsconfig.json", () => {
    const m = extract({
      "a.ts": `import axios from "axios";
export async function load() {
  const { data } = await axios.get("/orders");
  return data.total;
}`,
    });
    expect(m.apiCalls).toHaveLength(1);
    expect(m.propertyAccesses.map((a) => a.path)).toEqual([["total"]]);
  });

  it("recognizes axios instances created by a factory function and imported elsewhere", () => {
    const m = extract({
      "api.ts": `import axios from "axios";
const createApiInstance = (config: { baseURL: string }) => {
  const instance = axios.create({ withCredentials: true, ...config });
  instance.interceptors.request.use((c) => c);
  return instance;
};
function createVendorInstance() { return createApiInstance({ baseURL: "/vendor" }); }
export const userApiInstance = createApiInstance({ baseURL: "/api" });
export const vendorApiInstance = createVendorInstance();`,
      "index.ts": `export { userApiInstance, vendorApiInstance } from "./api";`,
      "a.ts": `import { userApiInstance, vendorApiInstance } from "./index";
export async function load() {
  const { data } = await userApiInstance.get<{ total: number }>("/orders");
  await vendorApiInstance.delete(\`/vendors/\${data.total}\`);
  return data.total;
}`,
    });
    expect(m.apiCalls.map((c) => `${c.method} ${c.endpointPattern}`)).toEqual([
      "GET /api/orders",
      "DELETE /vendor/vendors/{param}",
    ]);
  });

  it("prefixes an instance's baseURL resolved from env files, also through a client wrapper object", () => {
    const m = extract(
      {
        ".env": `# comment\nVITE_API_PREFIX=/api/console/admin\nVITE_NCP_SUFFIX="/api/console/admin/v1/ncp"`,
        "api.ts": `import axios from "axios";
const create = (config: { baseURL: string }) => axios.create({ ...config });
const API_PATH = import.meta.env.VITE_API_PREFIX;
export const gatewayApi = create({ baseURL: API_PATH });
export const ncpInstance = create({ baseURL: \`\${import.meta.env.VITE_NCP_SUFFIX}\` });
export const unknownApi = create({ baseURL: import.meta.env.VITE_MISSING });
export const ncpApi = {
  get(url: string) { return ncpInstance.get(url); },
};`,
        "a.ts": `import { gatewayApi, ncpApi, unknownApi } from "./api";
export async function load(id: number) {
  await gatewayApi.get(\`/v1/users/\${id}\`);
  await ncpApi.get("/servers");
  await unknownApi.get("/v1/orders");
  await gatewayApi.get("https://other.example.com/v1/x");
}`,
      },
      { envFiles: [".env"] },
    );
    expect(m.apiCalls.filter((c) => c.file === "a.ts").map((c) => `${c.method} ${c.endpointPattern}`)).toEqual([
      "GET /api/console/admin/v1/users/{param}",
      "GET /api/console/admin/v1/ncp/servers",
      "GET /v1/orders",
      "GET /v1/x",
    ]);
  });

  it("follows Vue Query results, refs and computed values through `.value`", () => {
    const m = extract({
      "api.ts": `import axios from "axios";
export const getVpcs = () => axios.get<{ data: { id: string }[] }>("/vpcs");`,
      "useVpcQuery.ts": `import { useQuery } from "@tanstack/vue-query";
import { getVpcs } from "./api";
export const useVpcQuery = () => useQuery({ queryKey: ["vpcs"], queryFn: () => getVpcs() });`,
      "a.ts": `import { computed, ref } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { getVpcs } from "./api";
import { useVpcQuery } from "./useVpcQuery";
export function useVpcs() {
  const { data: vpcData } = useQuery({ queryFn: async () => (await getVpcs()).data });
  const ids = computed(() => vpcData.value?.data.map((v) => v.id));
  const first = computed(() => vpcData.value?.data[0]);
  const query = useVpcQuery();
  const total = ref();
  getVpcs().then((res) => { total.value = res.data; });
  return [ids, first.value?.name, query.data.value?.data.region, total.value.count];
}`,
    });
    const reads = m.propertyAccesses.filter((a) => a.file === "a.ts").map((a) => `${a.location.line}:${a.path.join(".")}`);
    expect(reads).toEqual([
      "7:data",
      "7:data.[].id",
      "8:data.[]",
      "12:data.[].name",
      "12:region",
      "12:count",
    ]);
  });

  it("groups reads that are alternatives of one `??` / `||` chain", () => {
    const m = extract({
      "a.ts": `import axios from "axios";
const num = (v: unknown) => Number(v);
export async function load() {
  const { data } = await axios.get("/templates");
  const md = data.metaData ?? (data.metadata as object) ?? data.meta_data;
  const mem = num(data.memoryGb) || num(data.memory_gb);
  return [md, mem, data.name];
}`,
    });
    const groups = new Map(m.propertyAccesses.map((a) => [a.path.join("."), a.fallbackGroup]));
    expect(groups.get("metaData")).toBeDefined();
    expect(groups.get("metadata")).toBe(groups.get("metaData"));
    expect(groups.get("meta_data")).toBe(groups.get("metaData"));
    expect(groups.get("memory_gb")).toBe(groups.get("memoryGb"));
    expect(groups.get("memoryGb")).not.toBe(groups.get("metaData"));
    expect(groups.get("name")).toBeUndefined();
  });

  it("analyzes Vue single-file components: script setup, template reads, v-for and child props", () => {
    const m = extract({
      "api.ts": `import axios from "axios";
export const getUsers = () => axios.get<{ data: { id: string; name: string }[] }>("/users");`,
      "UserList.vue": `<template>
  <ul v-if="users">
    <li v-for="(u, i) in users.data" :key="u.id" @click="select(u)">
      {{ u.name }} {{ i }}
      <UserCard :user-info="u" />
    </li>
  </ul>
  <p>{{ total.count }}</p>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { getUsers } from "./api";
import UserCard from "./UserCard.vue";
const { data: users } = useQuery({ queryFn: async () => (await getUsers()).data });
const total = ref();
getUsers().then((res) => { total.value = res.data; });
function select(user: { id: string }) { return user.id; }
</script>`,
      "UserCard.vue": `<script setup lang="ts">
interface Props { userInfo: { email: string } }
const props = defineProps<Props>();
const email = props.userInfo.email;
</script>

<template>
  <span>{{ userInfo.nickname }}</span>
</template>`,
    });
    const reads = m.propertyAccesses
      .map((a) => `${a.file}:${a.location.line} ${a.path.join(".")} ${a.code}`)
      .sort();
    expect(reads).toEqual([
      "UserCard.vue:4 data.[].email props.userInfo.email",
      "UserCard.vue:8 data.[].nickname userInfo.nickname",
      "UserList.vue:19 data.[].id user.id",
      "UserList.vue:3 data users.data",
      "UserList.vue:3 data.[].id u.id",
      "UserList.vue:4 data.[].name u.name",
      "UserList.vue:8 count total.count",
    ].sort());
    expect(m.apiCalls.every((c) => c.file === "api.ts" || c.file === "UserList.vue")).toBe(true);
    expect(m.files.map((f) => f.path)).toContain("UserCard.vue");
  });

  it("does not grow paths without bound through recursive functions", () => {
    const m = extract({
      "a.ts": `import axios from "axios";
function walk(node: any): string[] {
  return [node.name, ...node.children.flatMap((c: any) => walk(c))];
}
export async function load() {
  const { data } = await axios.get("/tree");
  return walk(data.root);
}`,
    });
    expect(m.propertyAccesses.map((a) => a.path.join("."))).toEqual(["root.name", "root.children", "root"]);
  });

  it("evaluates a helper's result per call", () => {
    const m = extract({
      "a.ts": `import axios from "axios";
const toRecord = (obj: unknown) => (obj && typeof obj === "object" ? (obj as Record<string, any>) : {});
export async function load() {
  const { data } = await axios.get("/templates");
  const attrs = toRecord(data.attributes);
  const md = toRecord(attrs.metaData);
  return [md.disks, attrs.name];
}`,
    });
    const reads = m.propertyAccesses.filter((a) => a.location.line === 7).map((a) => a.path.join("."));
    expect(reads).toEqual(["attributes.metaData.disks", "attributes.name"]);
  });

  it("resolves path aliases from the tsconfig nearest to each file when there is no root tsconfig.json", () => {
    const m = extract({
      "libs/api/src/index.ts": `import axios from "axios";
export const api = axios.create();`,
      "packages/app/tsconfig.json": `{
  // comments are allowed
  "compilerOptions": { "baseUrl": "./src", "paths": { "@shared-api": ["../../../libs/api/src"] } }
}`,
      "packages/app/src/load.ts": `import { api } from "@shared-api";
export async function load() {
  const { data } = await api.get("/orders");
  return data.total;
}`,
    });
    expect(m.apiCalls).toEqual([expect.objectContaining({ method: "GET", endpointPattern: "/orders" })]);
    expect(m.propertyAccesses.map((a) => a.path)).toEqual([["total"]]);
  });

  it("resolves imports of workspace packages without node_modules", () => {
    const m = extract({
      "libs/api/package.json": `{ "name": "@shared-api", "main": "./src/index.ts", "types": "./src/index.d.ts" }`,
      "libs/api/src/index.ts": `export * from "./client";`,
      "libs/api/src/client.ts": `import axios from "axios";
export const api = axios.create();`,
      "packages/app/src/load.ts": `import { api } from "@shared-api";
export async function load() {
  const { data } = await api.get("/orders");
  return data.total;
}`,
    });
    expect(m.apiCalls).toEqual([expect.objectContaining({ method: "GET", endpointPattern: "/orders" })]);
  });

  it("does not link a shadowed variable with the same name", () => {
    const m = extract({
      "a.ts": `import axios from "axios";
export async function withApi() {
  const res = await axios.get("/users/1");
  return res.data.name;
}
export function withoutApi(res: { data: { name: string } }) {
  return res.data.name;
}`,
    });
    expect(m.propertyAccesses).toHaveLength(1);
    expect(m.propertyAccesses[0].location.line).toBe(4);
  });

  it("does not guess an endpoint for a fully dynamic URL", () => {
    const m = extract({
      "a.ts": `import axios from "axios";
export function load(url: string) { return axios.get(url); }`,
    });
    expect(m.apiCalls).toEqual([expect.objectContaining({ endpointPattern: null, method: "GET" })]);
  });

  it("inlines string constants used in a URL", () => {
    const m = extract({
      "paths.ts": `export const REQUESTS = "/v1/service-requests";`,
      "a.ts": `import axios from "axios";
import { REQUESTS } from "./paths";
const ORDERS = \`/v1/orders\`;
export function load(id: string) {
  axios.get(\`\${REQUESTS}/approval-list\`);
  axios.get(ORDERS);
  axios.get(REQUESTS + "/" + id);
  axios.get(\`\${REQUESTS}/\${id}\`);
}`,
    });
    expect(m.apiCalls.map((c) => c.endpointPattern)).toEqual([
      "/v1/service-requests/approval-list",
      "/v1/orders",
      "/v1/service-requests/{param}",
      "/v1/service-requests/{param}",
    ]);
  });

  it("substitutes a wrapper's URL parameter at the call site", () => {
    const m = extract({
      "a.ts": `import axios from "axios";
function request(url: string) { return axios.get(url).then((r) => r.data); }
export async function load(id: number) {
  const order = await request(\`/orders/\${id}\`);
  return order.total;
}`,
    });
    const wrapperCall = m.apiCalls.find((c) => c.resolution === "wrapper");
    expect(wrapperCall).toMatchObject({ endpointPattern: "/orders/{param}", method: "GET" });
    expect(m.propertyAccesses).toEqual([
      expect.objectContaining({ apiCallId: wrapperCall!.id, path: ["total"] }),
    ]);
  });

  it("ignores method calls on accessed fields", () => {
    const m = extract({
      "a.ts": `import axios from "axios";
export async function load() {
  const { data } = await axios.get("/users/1");
  return data.name.toUpperCase();
}`,
    });
    expect(m.propertyAccesses.map((a) => a.path)).toEqual([["name"]]);
  });
});

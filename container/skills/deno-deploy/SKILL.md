---
name: deno-deploy
description: Deploy web apps and APIs to Deno Deploy. Use when user asks to build and publish something to the web, create a site, deploy an app, or make something publicly accessible.
---

# Deno Deploy — Build & Publish Web Apps

You can build web applications and deploy them to Deno Deploy using the `deno` CLI.

## Prerequisites

The Deno Deploy token is stored in this group's workspace at
`/workspace/group/.credentials/deno-deploy-token`. Pass it explicitly on every call:

```bash
--token "$(cat /workspace/group/.credentials/deno-deploy-token)"
```

It is already configured — do NOT ask the user to set it up. Never echo the token or send
it to any host other than Deno.

(There is no `DENO_DEPLOY_TOKEN` environment variable: NanoClaw v2 has no host-env
passthrough, and `deno deploy` validates the token format locally, so gateway credential
injection does not apply here.)

## Project Structure

Each project lives in its own directory under `/workspace/group/projects/`:

```
/workspace/group/projects/
  weather/
    main.ts
    .gitignore
  photo-gallery/
    main.ts
    static/
    .gitignore
```

## Creating a New Project

1. Create the project directory:
   ```bash
   mkdir -p /workspace/group/projects/{name}
   cd /workspace/group/projects/{name}
   ```

2. Write the app code. Use Deno-native APIs (no package.json needed):
   ```typescript
   // main.ts
   Deno.serve((req: Request) => {
     const url = new URL(req.url);
     if (url.pathname === "/") {
       return new Response("<h1>Hello!</h1>", {
         headers: { "content-type": "text/html" },
       });
     }
     return new Response("Not Found", { status: 404 });
   });
   ```

3. Add a `.gitignore`:
   ```bash
   echo ".git/" > .gitignore
   ```

4. Initialize git for version control:
   ```bash
   git init
   git add -A
   git commit -m "initial version"
   ```

## Deploying

**First deployment** (app doesn't exist yet — create it first):

```bash
cd /workspace/group/projects/{name}
deno deploy create --app={name} --org=theowenyoung --token "$(cat /workspace/group/.credentials/deno-deploy-token)" .
deno deploy --prod --app={name} --org=theowenyoung --token "$(cat /workspace/group/.credentials/deno-deploy-token)" .
```

**Subsequent deployments** (app already exists):

```bash
cd /workspace/group/projects/{name}
deno deploy --prod --app={name} --org=theowenyoung --token "$(cat /workspace/group/.credentials/deno-deploy-token)" .
```

IMPORTANT:
- The `.` at the end is the root directory — required
- Do NOT pass `--endpoint` or `--entrypoint` flags — the entrypoint is auto-detected from the project
- Do NOT set "App Directory" in Deno Deploy dashboard — leave it empty
- The `--org=theowenyoung` is required

After deployment, the app is available at: `https://{name}.theowenyoung.deno.net/`

## Updating an Existing Project

1. Navigate to the project directory
2. Make changes
3. Commit:
   ```bash
   git add -A
   git commit -m "description of changes"
   ```
4. Re-deploy:
   ```bash
   deno deploy --prod --app={name} --org=theowenyoung --token "$(cat /workspace/group/.credentials/deno-deploy-token)" .
   ```

## Project Naming Conventions

- Use lowercase kebab-case: `weather-app`, `photo-gallery`, `api-tools`
- Keep names short and descriptive
- Names must be globally unique on Deno Deploy

## Capabilities Available on Deno Deploy

- **Deno KV**: Built-in key-value database (persistent, globally distributed)
- **Web standard APIs**: fetch, Request, Response, URL, crypto, etc.
- **npm packages**: Import with `npm:` prefix (e.g., `import express from "npm:express"`)
- **Static files**: Serve with `Deno.readFile()` or use a framework

## Tips

- Always test locally first: `deno run -A --unstable-kv --unstable-cron --unstable-broadcast-channel main.ts`
- Use `Deno.env.get("KEY")` for environment variables (set via Deno Deploy dashboard)
- For static sites with assets, use the Deno standard library file server or inline HTML
- After deploying, share the URL with the user

## Listing Projects

To see what's already deployed:
```bash
ls /workspace/group/projects/
```

## Error Recovery

If deployment fails:
1. Check the error message from `deno deploy`
2. Fix the code issue
3. Test locally with `deno run -A --unstable-kv --unstable-cron --unstable-broadcast-channel main.ts`
4. Re-deploy
5. If the project name is taken, choose a different name

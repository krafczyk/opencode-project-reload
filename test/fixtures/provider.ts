export type ProviderCapture = {
  body: Record<string, unknown>
  url: URL
}

export type ProviderFixture = {
  captures: ProviderCapture[]
  stop: () => Promise<void>
  url: string
}

function completion() {
  const lines = [
    {
      id: "chatcmpl-compat",
      object: "chat.completion.chunk",
      choices: [{ delta: { role: "assistant" } }],
    },
    {
      id: "chatcmpl-compat",
      object: "chat.completion.chunk",
      choices: [{ delta: { content: "captured" } }],
    },
    {
      id: "chatcmpl-compat",
      object: "chat.completion.chunk",
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ]
  return `${lines.map((line) => `data: ${JSON.stringify(line)}`).join("\n\n")}\n\ndata: [DONE]\n\n`
}

export function startProviderCapture(): ProviderFixture {
  const captures: ProviderCapture[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
        return new Response("not found", { status: 404 })
      }

      const body = await request.json().catch(() => undefined)
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return new Response("invalid request", { status: 400 })
      }
      captures.push({ body: body as Record<string, unknown>, url })
      return new Response(completion(), {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })

  return {
    captures,
    stop: async () => {
      await server.stop(true)
    },
    url: `http://${server.hostname}:${server.port}/v1`,
  }
}

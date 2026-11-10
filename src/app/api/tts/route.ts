const voices = new Set(["pt-BR-AntonioNeural", "pt-BR-FranciscaNeural"]);

function escapeXml(value: string) {
  return value.replace(/[<>&'"]/g, (character) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "'": "&apos;",
    "\"": "&quot;",
  })[character] || character);
}

export async function POST(request: Request) {
  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;
  if (!key || !region) {
    return Response.json({ error: "Azure Speech não está configurado no servidor." }, { status: 503 });
  }

  const body = await request.json() as { text?: string; voice?: string; rate?: number; pitch?: number };
  const text = body.text?.trim();
  const voice = voices.has(body.voice || "") ? body.voice : "pt-BR-AntonioNeural";
  if (!text || text.length > 500) {
    return Response.json({ error: "Texto inválido para síntese." }, { status: 400 });
  }

  const rate = Math.max(0.5, Math.min(2, Number(body.rate) || 1));
  const pitch = Math.max(0.5, Math.min(2, Number(body.pitch) || 1));
  const endpoint = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const ssml = `<speak version="1.0" xml:lang="pt-BR"><voice name="${voice}"><prosody rate="${Math.round((rate - 1) * 100)}%" pitch="${Math.round((pitch - 1) * 50)}%">${escapeXml(text)}</prosody></voice></speak>`;
  const azureResponse = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": key,
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
    },
    body: ssml,
  });
  if (!azureResponse.ok) {
    return Response.json({ error: "Azure Speech recusou a síntese." }, { status: 502 });
  }
  return new Response(await azureResponse.arrayBuffer(), {
    headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
  });
}

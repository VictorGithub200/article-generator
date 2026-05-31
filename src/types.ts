export type SubtitleSource = "youtube" | "user_input";

export interface GenerateRequest {
  youtubeUrl: string;
  subtitleInput?: string;
  guidance?: string;
}

export interface GenerateContext {
  contextId: string;
  createdAt: string;
  youtubeUrl: string;
  videoId: string;
  subtitleSource: SubtitleSource;
  transcript: string;
  articleHtml: string;
  sections: SectionContext[];
}

export interface SectionContext {
  id: string;
  title: string;
  excerpt: string;
}

export interface FiveW1HResult {
  Who: string;
  What: string;
  When: string;
  Where: string;
  Why: string;
  How: string;
}

export interface Env {
  ASSETS: Fetcher;
  CONTEXT_STORE: DurableObjectNamespace;
  GEMINI_API_KEY: string;
  GEMINI_MODEL?: string;
  YOUTUBE_FETCH_TIMEOUT_MS?: string;
  WEBSHARE_PROXY_ENABLED?: string;
  WEBSHARE_PROXY_HOST?: string;
  WEBSHARE_PROXY_PORT?: string;
  WEBSHARE_PROXY_USERNAME?: string;
  WEBSHARE_PROXY_PASSWORD?: string;
  WEBSHARE_PROXY_ONLY?: string;
}

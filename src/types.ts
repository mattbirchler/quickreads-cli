// Wire shapes, mirroring the JSON the Quick Reads API returns as documented at
// https://quickreads.app/docs. Fields the CLI never reads are left out; fields
// the docs describe as absent on some endpoints are optional here.

export interface Account {
  id: string;
  email: string;
  tier: 'basic' | 'pro' | 'free' | string;
  features?: Record<string, boolean>;
  subscription?: {
    status: string;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  };
}

export interface Tag {
  id: string;
  name: string;
  color: string;
  // Only on GET /api/tags.
  articleCount?: number;
}

export type ArticleList = 'queue' | 'todo';

export interface Article {
  id: string;
  url: string;
  // False when `url` is a Quick Reads placeholder (pasted text, a newsletter
  // with no web version). Nothing is served there, so it must not be opened.
  hasOriginalUrl?: boolean;
  title: string | null;
  author: string | null;
  siteName: string | null;
  // Omitted by list requests made with includeContent=false; null on links.
  content?: string | null;
  excerpt: string | null;
  wordCount: number;
  highlightCount?: number;
  type: 'article' | 'link' | 'pdf' | string;
  list?: ArticleList;
  source?: string;
  fetchBlocked?: boolean;
  publishedAt: string | null;
  savedAt: string;
  archivedAt: string | null;
  updatedAt?: string;
  readProgress?: number;
  tags?: Tag[];
}

export interface Highlight {
  id: string;
  articleId: string;
  text: string;
  note?: string | null;
  createdAt: string;
  // Only on the cross-article list (GET /api/highlights).
  articleTitle?: string | null;
  url?: string | null;
  siteName?: string | null;
  author?: string | null;
}

export interface HighlightsPage {
  highlights: Highlight[];
  total: number;
}

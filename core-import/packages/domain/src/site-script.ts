export interface SiteScriptRevision {
  revision: number;
  name: string;
  matches: string[];
  code: string;
  css: string;
  createdAt: string;
}
export interface SiteScriptRecord extends SiteScriptRevision {
  scriptId: string;
  clientInstanceId: string;
  chatId: string;
  enabled: boolean;
  history: SiteScriptRevision[];
}

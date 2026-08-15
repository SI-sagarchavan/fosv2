export interface BoardPage {
  fileKey: string | null;
  fileName: string;
  pageName: string;
  rootNodeId: string | null;
  rootName: string | null;
}

export interface BoardShot {
  name: string;
  nodeId: string;
  src: string;
}

export interface BoardExport {
  id: string;
  at: number;
  receivedAt: number;
  page: BoardPage;
  jsonName: string;
  summary: Record<string, unknown>;
  screenshots: BoardShot[];
}

export interface BoardList {
  exports: BoardExport[];
}

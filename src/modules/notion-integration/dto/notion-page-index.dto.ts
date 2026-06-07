export class NotionPageIndexItemDto {
  notionPageId: string;
  title: string;
  pageType: 'page' | 'database';
  indexedAt: string;
}

export class NotionPageIndexDto {
  items: NotionPageIndexItemDto[];
  stale: boolean;
}

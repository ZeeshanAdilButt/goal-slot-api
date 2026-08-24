import { NotionBlockDto } from './notion-block.dto';

export class NotionDatabasePageItemDto {
  notionPageId: string;
  title: string;
}

export class NotionPageContentDto {
  contentType: 'page' | 'database';
  pageId: string;
  title: string;
  blocks?: NotionBlockDto[];
  pages?: NotionDatabasePageItemDto[];
}

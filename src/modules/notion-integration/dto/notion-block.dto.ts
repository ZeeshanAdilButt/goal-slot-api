export class NotionBlockDto {
  id: string;
  type: string;
  text: string;
  children?: NotionBlockDto[];
}

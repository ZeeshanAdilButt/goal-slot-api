import { Controller, Get, Param } from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { WhiteboardsService } from "./whiteboards.service";

@ApiTags("public-whiteboards")
@Controller("public/whiteboards")
export class PublicWhiteboardsController {
  constructor(private readonly whiteboardsService: WhiteboardsService) {}

  @Get(":token")
  @ApiOperation({ summary: "Fetch a publicly shared whiteboard by its token" })
  async findByToken(@Param("token") token: string) {
    return this.whiteboardsService.findByPublicToken(token);
  }
}


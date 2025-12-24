import { Controller, Get, Post, Put, Delete, Body, Param, UseGuards, Request } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto, UpdateCategoryDto } from './dto/categories.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@ApiTags('categories')
@Controller('categories')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class CategoriesController {
  constructor(private categoriesService: CategoriesService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new category' })
  async create(@Request() req: any, @Body() dto: CreateCategoryDto) {
    return this.categoriesService.create(req.user.sub, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all categories for the current user' })
  async findAll(@Request() req: any) {
    return this.categoriesService.findAll(req.user.sub);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a specific category' })
  async findOne(@Request() req: any, @Param('id') id: string) {
    return this.categoriesService.findOne(req.user.sub, id);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update a category' })
  async update(@Request() req: any, @Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    return this.categoriesService.update(req.user.sub, id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a category' })
  async delete(@Request() req: any, @Param('id') id: string) {
    return this.categoriesService.delete(req.user.sub, id);
  }
}


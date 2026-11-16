import { Module } from "@nestjs/common";
import { GameController } from "./game/game.controller";
import { GameService } from "./game/game.service";
import { CatalogService } from "./catalog/catalog.service";
import { PrismaService } from "./prisma/prisma.service";

@Module({
  controllers: [GameController],
  providers: [GameService, CatalogService, PrismaService],
})
export class AppModule {}

import { Module } from "@nestjs/common";
import { GameController } from "./game/game.controller";
import { GameService } from "./game/game.service";
import { DeezerService } from "./deezer/deezer.service";
import { PrismaService } from "./prisma/prisma.service";

@Module({
  controllers: [GameController],
  providers: [GameService, DeezerService, PrismaService],
})
export class AppModule {}

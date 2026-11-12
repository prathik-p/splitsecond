import { Module } from "@nestjs/common";
import { GameController } from "./game/game.controller";
import { GameService } from "./game/game.service";
import { DeezerService } from "./deezer/deezer.service";
import { ProfilesController } from "./profiles/profiles.controller";
import { ProfilesService } from "./profiles/profiles.service";
import { PrismaService } from "./prisma/prisma.service";

@Module({
  controllers: [GameController, ProfilesController],
  providers: [GameService, ProfilesService, DeezerService, PrismaService],
})
export class AppModule {}

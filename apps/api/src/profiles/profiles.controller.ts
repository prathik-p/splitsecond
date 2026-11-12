import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { ProfilesService } from "./profiles.service";

@Controller("profiles")
export class ProfilesController {
  constructor(private readonly profiles: ProfilesService) {}

  @Get()
  list() {
    return this.profiles.list();
  }

  /** Import (or, with `refresh`, re-import) a Last.fm user's music. */
  @Post()
  create(@Body() body: { username?: string; refresh?: boolean } = {}) {
    return this.profiles.importLastfm(body?.username, body?.refresh === true);
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.profiles.get(id);
  }
}

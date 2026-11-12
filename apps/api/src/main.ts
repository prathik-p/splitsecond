import "dotenv/config";
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

// Prisma returns BigInt for Deezer ids; make JSON.stringify not throw if one slips through.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix("api");
  app.enableCors({ origin: process.env.WEB_ORIGIN ?? "http://localhost:3000" });
  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port);
  console.log(`Split Second API on http://localhost:${port}/api`);
}
bootstrap();

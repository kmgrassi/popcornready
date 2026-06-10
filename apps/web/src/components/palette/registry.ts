import { studioCommands } from "../studio/commands";
import { homeCommands } from "../../routes/home/commands";
import { libraryCommands } from "../../routes/library/commands";
import { settingsCommands } from "../../routes/settings/commands";
import type { PaletteCommand } from "./Palette";

export const paletteCommands: PaletteCommand[] = [
  ...homeCommands,
  ...studioCommands,
  ...libraryCommands,
  ...settingsCommands,
];

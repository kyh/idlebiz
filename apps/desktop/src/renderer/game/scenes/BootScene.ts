import Phaser from "phaser";

/** Boot: hands straight off to OfficeScene (which preloads its own assets). */
export class BootScene extends Phaser.Scene {
  constructor() {
    super("boot");
  }

  create() {
    this.scene.start("office");
  }
}

import RAPIER from 'rapier';

// Физика на Rapier (https://rapier.rs): Rust, скомпилированный в WebAssembly.
// Шаг фиксированный, чтобы цепь вела себя одинаково при любой частоте кадров.

const TIMESTEP = 1 / 120;
const MAX_LAG = 0.25;

export async function createPhysics() {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = TIMESTEP;
  let lag = 0;
  const beforeStep = [];

  return {
    RAPIER,
    world,
    // Вызывается перед каждым шагом: здесь задаются силы на этот шаг.
    // Возвращает функцию, которая отписывает callback.
    onStep(callback) {
      beforeStep.push(callback);
      return () => {
        const index = beforeStep.indexOf(callback);
        if (index >= 0) beforeStep.splice(index, 1);
      };
    },
    step(dt) {
      lag = Math.min(lag + dt, MAX_LAG);
      while (lag >= TIMESTEP) {
        [...beforeStep].forEach((callback) => callback());
        world.step();
        lag -= TIMESTEP;
      }
    },
  };
}

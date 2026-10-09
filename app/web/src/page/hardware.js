import * as THREE from 'three';

// Подвесная фурнитура объектов: тросы, ушки и кольцо, за которое объект держит цепь.

const UP = new THREE.Vector3(0, 1, 0);
const EYE = [0.016, 0.0045, 10, 24];

// Геометрия тонкого цилиндра между двумя точками (уже на месте, для слияния).
export function rodGeometry(from, to, radius, segments = 8) {
  const direction = new THREE.Vector3().subVectors(to, from);
  const geometry = new THREE.CylinderGeometry(radius, radius, direction.length(), segments);
  const middle = from.clone().addScaledVector(direction, 0.5);
  const rotation = new THREE.Quaternion().setFromUnitVectors(UP, direction.normalize());
  return geometry.applyMatrix4(new THREE.Matrix4().compose(middle, rotation, new THREE.Vector3(1, 1, 1)));
}

export function rod(from, to, radius, material) {
  return new THREE.Mesh(rodGeometry(from, to, radius), material);
}

// Два ушка на верхней кромке (x = ±eyeX, y = eyeY), тросы от них к кольцу
// на высоте ringY. Возвращает точку крепления цепи.
export function addBridle(group, material, { eyeX, eyeY, ringY }) {
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.TorusGeometry(...EYE), material);
    eye.position.set(side * eyeX, eyeY, 0);
    group.add(eye);
    group.add(rod(new THREE.Vector3(side * eyeX, eyeY + 0.012, 0), new THREE.Vector3(side * 0.012, ringY - 0.018, 0), 0.0028, material));
  }
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.022, 0.005, 10, 28), material);
  ring.position.y = ringY;
  ring.rotation.y = Math.PI / 2;
  group.add(ring);
  return new THREE.Vector3(0, ringY + 0.022, 0);
}

// Два ушка на верхней кромке без тросов и кольца: объект висит на двух цепях,
// каждая цепляется за своё ушко. Возвращает точки крепления цепей.
export function addTopEyes(group, material, { eyeX, eyeY }) {
  return [-1, 1].map((side) => {
    const eye = new THREE.Mesh(new THREE.TorusGeometry(...EYE), material);
    eye.position.set(side * eyeX, eyeY, 0);
    group.add(eye);
    return new THREE.Vector3(side * eyeX, eyeY + EYE[0], 0);
  });
}

// Нижнее ушко под кромкой bottom в точке x. Возвращает точку подвеса
// для того, что будет висеть ниже.
export function addHangerEye(group, material, x, bottom) {
  const eye = new THREE.Mesh(new THREE.TorusGeometry(...EYE), material);
  eye.position.set(x, bottom - 0.016, 0);
  eye.rotation.y = Math.PI / 2;
  group.add(eye);
  return new THREE.Vector3(x, bottom - 0.028, 0);
}

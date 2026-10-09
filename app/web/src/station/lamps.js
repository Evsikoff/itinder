import * as THREE from 'three';
import { LAMPS, STATION } from '../config.js';

// Бесконечный ряд потолочных светильников. Обычных источников света в three.js
// на сотни метров станции не хватит, поэтому материал сам считает свет ближайших
// светильников: шейдер находит пролёт, в котором лежит фрагмент, и добавляет вклад
// ламп этого и соседних пролётов через ту же BRDF, что и у штатных источников.

const uniforms = {
  uLampColor: { value: new THREE.Color().setRGB(...LAMPS.color).multiplyScalar(LAMPS.intensity) },
  uLampX: { value: new THREE.Vector4(...LAMPS.xs) },
  uLampY: { value: LAMPS.y },
  uLampPeriod: { value: STATION.bay },
  uLampRange: { value: LAMPS.range },
};

const VERTEX_DECLARATIONS = /* glsl */`
varying vec3 vLampWorld;
`;

const VERTEX_WORLD = /* glsl */`
{
  vec4 lampWorld = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    lampWorld = instanceMatrix * lampWorld;
  #endif
  vLampWorld = ( modelMatrix * lampWorld ).xyz;
}
`;

const FRAGMENT_DECLARATIONS = /* glsl */`
varying vec3 vLampWorld;
uniform vec3 uLampColor;
uniform vec4 uLampX;
uniform float uLampY;
uniform float uLampPeriod;
uniform float uLampRange;
`;

const FRAGMENT_LIGHTS = /* glsl */`
{
  float lampRow = floor( vLampWorld.z / uLampPeriod + 0.5 );
  for ( int j = -1; j <= 1; j ++ ) {
    float lampZ = ( lampRow + float( j ) ) * uLampPeriod;
    for ( int i = 0; i < 4; i ++ ) {
      vec3 toFragment = vLampWorld - vec3( uLampX[ i ], uLampY, lampZ );
      float lampDistance = length( toFragment );
      if ( lampDistance > uLampRange ) continue;
      // Светильник утоплен в потолок и светит в основном вниз.
      float downward = clamp( - toFragment.y / max( lampDistance, 1e-4 ), 0.0, 1.0 );
      IncidentLight lamp;
      lamp.direction = normalize( ( viewMatrix * vec4( - toFragment, 0.0 ) ).xyz );
      lamp.color = uLampColor * mix( 0.18, 1.0, downward ) * getDistanceAttenuation( lampDistance, uLampRange, 2.0 );
      lamp.visible = true;
      RE_Direct( lamp, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
    }
  }
}
`;

// Подключает свет светильников к MeshStandardMaterial / MeshPhysicalMaterial.
export function lit(material) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_DECLARATIONS}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${VERTEX_WORLD}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_DECLARATIONS}`)
      .replace('#include <lights_fragment_end>', `${FRAGMENT_LIGHTS}\n#include <lights_fragment_end>`);
  };
  material.customProgramCacheKey = () => 'station-lamps';
  return material;
}

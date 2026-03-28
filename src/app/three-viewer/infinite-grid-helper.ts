import * as THREE from 'three';

export class InfiniteGridHelper extends THREE.Mesh {
  constructor(size1 = 1, size2 = 10, color = new THREE.Color('white'), distance = 8000, axes: 'xz' | 'xy' | 'yz' = 'xz') {
    
    let planeAxes = 'xzy';
    let c1 = 'x';
    let c2 = 'z';
    
    if (axes === 'xy') {
      planeAxes = 'xyz';
      c1 = 'x';
      c2 = 'y';
    } else if (axes === 'yz') {
      planeAxes = 'zyx';
      c1 = 'y';
      c2 = 'z';
    }

    const material = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      uniforms: {
        uSize1: { value: size1 },
        uSize2: { value: size2 },
        uColor: { value: color },
        uDistance: { value: distance }
      },
      vertexShader: `
        varying vec3 worldPosition;
        uniform float uDistance;
        void main() {
          vec3 pos = position.${planeAxes} * uDistance;
          pos.${axes} += cameraPosition.${axes};
          worldPosition = pos;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
        }
      `,
      fragmentShader: `
        varying vec3 worldPosition;
        uniform float uSize1;
        uniform float uSize2;
        uniform vec3 uColor;
        uniform float uDistance;

        float getGrid(float size) {
          vec2 r = worldPosition.${axes} / size;
          vec2 grid = abs(fract(r - 0.5) - 0.5) / fwidth(r);
          float line = min(grid.x, grid.y);
          return 1.0 - min(line, 1.0);
        }

        void main() {
          float d = 1.0 - min(distance(cameraPosition.${axes}, worldPosition.${axes}) / uDistance, 1.0);
          
          float g1 = getGrid(uSize1);
          float g2 = getGrid(uSize2);
          
          float alpha = mix(g2, g1, g1) * pow(d, 3.0);
          alpha *= 0.4;
          
          vec3 col = uColor;
          if (abs(worldPosition.${c1}) < 0.2 * uSize1) {
             col = vec3(0.1, 0.4, 1.0); 
          }
          if (abs(worldPosition.${c2}) < 0.2 * uSize1) {
             col = vec3(1.0, 0.1, 0.2); 
          }

          gl_FragColor = vec4(col, alpha);
        }
      `
    });

    const geometry = new THREE.PlaneGeometry(2, 2, 1, 1);
    super(geometry, material);
    this.frustumCulled = false;
  }
}

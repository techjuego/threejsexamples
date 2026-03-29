import { Component, ElementRef, ViewChild, AfterViewInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import * as THREE from 'three';
// @ts-ignore
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import ViewCubeControls from './view-cube-controls';
import { InfiniteGridHelper } from './infinite-grid-helper';


@Component({
  selector: 'app-three-viewer',
  imports: [CommonModule],
  templateUrl: './three-viewer.html',
  styleUrl: './three-viewer.scss',
})
export class ThreeViewer implements AfterViewInit, OnDestroy {
  @ViewChild('rendererContainer', { static: true }) rendererContainer!: ElementRef<HTMLDivElement>;
  @ViewChild('cubeSceneContainer', { static: true }) cubeSceneContainer!: ElementRef<HTMLDivElement>;

  constructor(private cdr: ChangeDetectorRef) { }

  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;

  private camera!: THREE.OrthographicCamera | THREE.PerspectiveCamera;

  public showContextMenu = false;
  public contextMenuX = 0;
  public contextMenuY = 0;
  public contextMenuObject: THREE.Object3D | null = null;
  private persCamera!: THREE.PerspectiveCamera;
  private orthoCamera!: THREE.OrthographicCamera;
  private frustumSize = 40;

  private orbitControls!: OrbitControls;

  private cubeRenderer!: THREE.WebGLRenderer;
  private cubeScene!: THREE.Scene;
  private cubeCamera!: THREE.PerspectiveCamera;
  private viewCube!: ViewCubeControls;

  public selectedNode: THREE.Object3D | null = null;
  private gridHelperXZ!: InfiniteGridHelper;
  private gridHelperXY!: InfiniteGridHelper;
  private gridHelperYZ!: InfiniteGridHelper;

  public hRoot: THREE.Group = new THREE.Group();

  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();

  gridVisible = true;
  snapEnabled = false;
  private animationId!: number;
  private lastOrthoQuaternion = new THREE.Quaternion();
  private lastOrthographicFace?: number;
  private collisionHelper: THREE.BoxHelper | null = null;



  toggleGrid() {
    this.gridVisible = !this.gridVisible;
    this.updateVisibleGrids(this.lastOrthographicFace);
  }

  private updateVisibleGrids(face?: number) {
    if (!this.gridVisible) {
      this.gridHelperXZ.visible = false;
      this.gridHelperXY.visible = false;
      this.gridHelperYZ.visible = false;
      return;
    }

    if (this.camera === this.persCamera || face === undefined) {
      this.gridHelperXZ.visible = true;
      this.gridHelperXY.visible = false;
      this.gridHelperYZ.visible = false;
      return;
    }

    // TOP: 1, FRONT: 2, RIGHT: 3, BACK: 4, LEFT: 5, BOTTOM: 6
    if (face === 1 || face === 6) {
      this.gridHelperXZ.visible = true;
      this.gridHelperXY.visible = false;
      this.gridHelperYZ.visible = false;
    } else if (face === 2 || face === 4) {
      this.gridHelperXZ.visible = false;
      this.gridHelperXY.visible = true;
      this.gridHelperYZ.visible = false;
    } else if (face === 3 || face === 5) {
      this.gridHelperXZ.visible = false;
      this.gridHelperXY.visible = false;
      this.gridHelperYZ.visible = true;
    }
  }

  toggleSnap() {
    this.snapEnabled = !this.snapEnabled;
  }

  private clearCollisionHighlight(targetObj: THREE.Object3D) {
    targetObj.traverse((node) => {
      if (node instanceof THREE.Mesh && node.material && 'emissive' in node.material) {
        node.material.emissive.setHex(0x000000);
      }
    });
  }

  private clearCollisionHighlights() {
    this.hRoot.traverse((node) => {
      if (node instanceof THREE.Mesh && node.material && 'emissive' in node.material) {
        (node.material as THREE.MeshStandardMaterial).emissive.setHex(0x000000);
      }
    });
  }

  private checkAndHighlightCollisions(targetObj: THREE.Object3D) {
    if (!targetObj) return;

    let allMeshes: THREE.Mesh[] = [];
    this.hRoot.traverse((node) => {
      if (node instanceof THREE.Mesh && node.visible) {
        allMeshes.push(node);
      }
    });

    let targetMeshes: THREE.Mesh[] = [];
    targetObj.traverse((node) => {
      if (node instanceof THREE.Mesh) targetMeshes.push(node);
    });

    let isOverlapping = false;
    for (const tMesh of targetMeshes) {
      tMesh.updateMatrixWorld(true);
      const tBox = new THREE.Box3().setFromObject(tMesh);
      tBox.expandByScalar(-0.1); // Snap tolerance

      for (const aMesh of allMeshes) {
        if (targetMeshes.includes(aMesh)) continue; // ignore self submeshes

        const aBox = new THREE.Box3().setFromObject(aMesh);
        if (tBox.intersectsBox(aBox)) {
          isOverlapping = true;
          break;
        }
      }
      if (isOverlapping) break;
    }

    const collisionColor = isOverlapping ? 0xff0000 : 0x000000;
    for (const tMesh of targetMeshes) {
      if (tMesh.material && 'emissive' in tMesh.material) {
        (tMesh.material as THREE.MeshStandardMaterial).emissive.setHex(collisionColor);
      }
    }
  }



  ngAfterViewInit() {
    this.rendererContainer.nativeElement.addEventListener('contextmenu', (e: Event) => e.preventDefault());
    this.initMainScene();
    this.initCubeScene();
    this.animate();
    window.addEventListener('resize', this.onWindowResize.bind(this));
    this.cdr.detectChanges(); // Trigger Angular UI evaluation after items are dynamically spawned
  }

  ngOnDestroy(): void {
    window.removeEventListener('resize', this.onWindowResize.bind(this));
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
    }
    if (this.renderer) {
      this.renderer.dispose();
    }
    if (this.cubeRenderer) {
      this.cubeRenderer.dispose();
    }
    if (this.orbitControls) {
      this.orbitControls.dispose();
    }
  }

  private initMainScene(): void {
    const container = this.rendererContainer.nativeElement;

    this.scene = new THREE.Scene();

    const aspect = container.clientWidth / container.clientHeight;
    this.persCamera = new THREE.PerspectiveCamera(75, aspect, 0.1, 1000);
    this.persCamera.position.set(0, 15, 30);

    this.orthoCamera = new THREE.OrthographicCamera(
      (this.frustumSize * aspect) / -2,
      (this.frustumSize * aspect) / 2,
      this.frustumSize / 2,
      this.frustumSize / -2,
      -1000,
      1000
    );

    // Default to perspective
    this.camera = this.persCamera;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(this.renderer.domElement);

    this.orbitControls = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbitControls.enableDamping = true;
    this.orbitControls.dampingFactor = 0.05;

    this.gridHelperXZ = new InfiniteGridHelper(1, 10, new THREE.Color(0xdddddd), 500, 'xz');
    this.gridHelperXY = new InfiniteGridHelper(1, 10, new THREE.Color(0xdddddd), 500, 'xy');
    this.gridHelperYZ = new InfiniteGridHelper(1, 10, new THREE.Color(0xdddddd), 500, 'yz');
    this.gridHelperXY.visible = false;
    this.gridHelperYZ.visible = false;

    this.scene.add(this.gridHelperXZ);
    this.scene.add(this.gridHelperXY);
    this.scene.add(this.gridHelperYZ);

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(10, 20, 10);
    this.scene.add(dirLight);

    // Add Objects to hierarchy root instead of straight to scene
    this.hRoot.name = 'World Collection';
    this.hRoot.userData['expanded'] = true;
    this.scene.add(this.hRoot);

    const cubeGeo = new THREE.BoxGeometry(10, 10, 10);
    const cubeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, metalness: 0.1 });
    const cube = new THREE.Mesh(cubeGeo, cubeMat);
    cube.name = 'Center Box';
    cube.position.y = 5;
    this.hRoot.add(cube);

    const sphereGeo = new THREE.SphereGeometry(6, 32, 32);
    const sphereMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, metalness: 0.1 });
    const sphere = new THREE.Mesh(sphereGeo, sphereMat);
    sphere.name = 'Companion Sphere';
    sphere.position.set(15, 6, 0);
    this.hRoot.add(sphere);

    this.orbitControls.addEventListener('change', () => {
      if (this.camera instanceof THREE.OrthographicCamera) {
        // Prevent rotating horizontally/vertically via OrbitControls when locked to an Orthographic face
        this.camera.quaternion.copy(this.lastOrthoQuaternion);
      }
    });

    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown.bind(this));
  }

  private onPointerDown(event: PointerEvent): void {
    // Hide context menu automatically on any click natively
    if (this.showContextMenu) {
      this.showContextMenu = false;
      this.cdr.detectChanges();
    }

    if (event.button !== 0 && event.button !== 2) return;

    const container = this.rendererContainer.nativeElement;
    const rect = container.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / container.clientWidth) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / container.clientHeight) * 2 + 1;

    this.raycaster.setFromCamera(this.pointer, this.camera);
    const intersects = this.raycaster.intersectObject(this.hRoot, true);

    const validIntersects = intersects.filter(hit =>
      hit.object !== this.collisionHelper &&
      hit.object.visible
    );

    if (validIntersects.length > 0) {
      let selectedObject: THREE.Object3D | null = validIntersects[0].object;

      while (selectedObject && selectedObject !== this.hRoot) {
        if (selectedObject.name.includes('Box') || selectedObject.name.includes('Can') || selectedObject.name.includes('Sphere') || selectedObject.name.includes('Cylinder') || selectedObject.name.includes('Cone')) break;
        selectedObject = selectedObject.parent;
      }

      if (selectedObject && selectedObject !== this.hRoot) {
        if (this.selectedNode !== selectedObject) {
          if (this.selectedNode) this.clearCollisionHighlight(this.selectedNode);
          this.selectedNode = selectedObject;
        }
        this.checkAndHighlightCollisions(selectedObject);

        if (event.button === 2) {
          this.showContextMenu = true;
          this.contextMenuX = event.clientX;
          this.contextMenuY = event.clientY;
          this.contextMenuObject = selectedObject;
          this.cdr.detectChanges();
        }
      }
    } else {
      if (event.button === 0) {
        if (this.selectedNode) {
          this.clearCollisionHighlight(this.selectedNode);
          this.selectedNode = null;
        }
        this.clearCollisionHighlights();
      } else if (event.button === 2 && this.selectedNode) {
        this.showContextMenu = true;
        this.contextMenuX = event.clientX;
        this.contextMenuY = event.clientY;
        this.contextMenuObject = this.selectedNode;
        this.cdr.detectChanges();
      }
    }
  }

  deleteSelectedObject() {
    this.showContextMenu = false;
    const obj = this.contextMenuObject || this.selectedNode;
    if (obj) {
      if (this.selectedNode === obj) {
        this.clearCollisionHighlight(this.selectedNode);
        this.selectedNode = null;
      }
      const parent = obj.parent;
      if (parent) {
        parent.remove(obj);
      }

      // Explicit garbage collection unmounting to prevent ghost GPU allocations natively!
      obj.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          const mesh = child as THREE.Mesh;
          if (mesh.geometry) mesh.geometry.dispose();
          if (mesh.material) {
            if (Array.isArray(mesh.material)) mesh.material.forEach(m => m.dispose());
            else mesh.material.dispose();
          }
        }
      });

      this.contextMenuObject = null;
      this.cdr.detectChanges();
    }
  };

  private initCubeScene(): void {
    const container = this.cubeSceneContainer.nativeElement;

    this.cubeRenderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    this.cubeRenderer.setSize(150, 150);
    container.appendChild(this.cubeRenderer.domElement);

    this.cubeScene = new THREE.Scene();
    this.cubeCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    this.cubeCamera.position.set(0, 0, 70);
    this.cubeCamera.lookAt(0, 0, 0);

    // Add a static white plane behind the View Cube
    const planeGeo = new THREE.PlaneGeometry(300, 300);
    const planeMat = new THREE.MeshBasicMaterial({ color: 0xffffff, depthWrite: false });
    const bgPlane = new THREE.Mesh(planeGeo, planeMat);
    bgPlane.position.z = -50;
    this.cubeScene.add(bgPlane);

    this.viewCube = new ViewCubeControls(this.cubeCamera, undefined, undefined, this.cubeRenderer.domElement);
    this.cubeScene.add(this.viewCube.getObject());

    (this.viewCube as any).addEventListener('snap-complete', (e: any) => {
      this.setCameraMode(e.isOrtho ? 'orthographic' : 'perspective');
      if (e.isOrtho) {
        this.lastOrthoQuaternion.copy(this.camera.quaternion);
        this.lastOrthographicFace = e.face;
      } else {
        this.lastOrthographicFace = undefined;
      }
      this.updateVisibleGrids(this.lastOrthographicFace);
    });

    (this.viewCube as any).addEventListener('angle-change', (event: any) => {
      let q = event.quaternion.clone();
      if (typeof q.invert === 'function') q.invert();
      else if (typeof (q as any).inverse === 'function') (q as any).inverse();

      // update camera position to orbit around the target
      const distance = this.camera.position.distanceTo(this.orbitControls.target);
      this.camera.position.set(0, 0, distance).applyQuaternion(q).add(this.orbitControls.target);
      this.camera.quaternion.copy(q);
    });
  }

  private setCameraMode(mode: 'perspective' | 'orthographic') {
    if (mode === 'orthographic' && this.camera !== this.orthoCamera) {
      this.orthoCamera.position.copy(this.persCamera.position);
      this.orthoCamera.quaternion.copy(this.persCamera.quaternion);

      const distance = this.persCamera.position.distanceTo(this.orbitControls.target);
      const fovY = (this.persCamera.fov * Math.PI) / 180;
      const frustumHeight = 2 * Math.tan(fovY / 2) * distance;

      this.orthoCamera.zoom = this.frustumSize / frustumHeight;
      this.orthoCamera.updateProjectionMatrix();

      this.camera = this.orthoCamera;
      this.updateControlCameras();
    } else if (mode === 'perspective' && this.camera !== this.persCamera) {
      this.persCamera.position.copy(this.orthoCamera.position);
      this.persCamera.quaternion.copy(this.orthoCamera.quaternion);

      const frustumHeight = this.frustumSize / this.orthoCamera.zoom;
      const fovY = (this.persCamera.fov * Math.PI) / 180;
      const expectedDistance = frustumHeight / (2 * Math.tan(fovY / 2));

      const direction = new THREE.Vector3(0, 0, 1).applyQuaternion(this.orthoCamera.quaternion);
      this.persCamera.position.copy(this.orbitControls.target).add(direction.multiplyScalar(expectedDistance));
      this.persCamera.updateProjectionMatrix();

      this.camera = this.persCamera;
      this.updateControlCameras();

      // Force grid transition back to floor
      this.lastOrthographicFace = undefined;
      this.updateVisibleGrids();
    }
  }

  private updateControlCameras() {
    this.orbitControls.object = this.camera;
    this.orbitControls.update();
  }

  private animate = () => {
    this.animationId = requestAnimationFrame(this.animate);

    const isAnimatingCube = this.viewCube && !!(this.viewCube as any)._animation;

    if (this.orbitControls && !isAnimatingCube) {
      this.orbitControls.update();
    }

    // Sync ViewCube to OrbitControls only when ViewCube isn't animating itself
    if (this.viewCube && !isAnimatingCube) {
      let camQ = this.camera.quaternion.clone();
      if (typeof camQ.invert === 'function') camQ.invert();
      else if (typeof (camQ as any).inverse === 'function') (camQ as any).inverse();
      this.viewCube.setQuaternion(camQ);
    }

    if (this.viewCube) {
      this.viewCube.update();
    }

    if (this.renderer && this.scene && this.camera) {
      this.renderer.render(this.scene, this.camera);
    }

    if (this.cubeRenderer && this.cubeScene && this.cubeCamera) {
      this.cubeRenderer.render(this.cubeScene, this.cubeCamera);
    }
  };

  private onWindowResize(): void {
    const container = this.rendererContainer.nativeElement;

    if (this.renderer) {
      const aspect = container.clientWidth / container.clientHeight;

      this.persCamera.aspect = aspect;
      this.persCamera.updateProjectionMatrix();

      this.orthoCamera.left = (this.frustumSize * aspect) / -2;
      this.orthoCamera.right = (this.frustumSize * aspect) / 2;
      this.orthoCamera.top = this.frustumSize / 2;
      this.orthoCamera.bottom = this.frustumSize / -2;
      this.orthoCamera.updateProjectionMatrix();

      this.renderer.setSize(container.clientWidth, container.clientHeight);
    }
  }


}

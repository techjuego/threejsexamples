import { Component, ElementRef, ViewChild, AfterViewInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import * as THREE from 'three';
// @ts-ignore
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
// @ts-ignore
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import ViewCubeControls from './view-cube-controls';
import { InfiniteGridHelper } from './infinite-grid-helper';

export class ParametricShelf extends THREE.Group {
  private frameGeo = new THREE.BoxGeometry(10, 10, 5);
  private frameMat = new THREE.MeshStandardMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.2 });
  private frame = new THREE.Mesh(this.frameGeo, this.frameMat);

  constructor() {
    super();
    this.add(this.frame);

    const shelfCount = 3;
    for (let i = 0; i < shelfCount; i++) {
      const shelfGeo = new THREE.BoxGeometry(9.8, 0.4, 4.8);
      const shelfMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, metalness: 0.1 });
      const shelf = new THREE.Mesh(shelfGeo, shelfMat);
      shelf.name = `Shelf ${i + 1}`;
      this.add(shelf);
    }
    this.updateLayout();
  }

  onTransform() {
    this.updateLayout();
  }

  updateLayout() {
    // If the scale becomes very small or flips, protect it from dividing by 0
    let scY = this.scale.y;
    if (Math.abs(scY) < 0.001) scY = 0.001 * Math.sign(scY) || 0.001;

    const invY = 1.0 / scY;

    const shelves = this.children.filter(c => c.name.includes('Shelf')) as THREE.Mesh[];

    const totalHeight = 10;
    const spacing = totalHeight / (shelves.length + 1);

    for (let i = 0; i < shelves.length; i++) {
      const shelf = shelves[i];
      // Override local space to precisely center it natively on the cabinet
      shelf.position.x = 0;
      shelf.position.z = 0;
      shelf.rotation.set(0, 0, 0);

      shelf.scale.y = invY;
      shelf.position.y = -5 + ((i + 1) * spacing);
    }
  }
}

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

  public transformControl!: TransformControls;
  private gridHelperXZ!: InfiniteGridHelper;
  private gridHelperXY!: InfiniteGridHelper;
  private gridHelperYZ!: InfiniteGridHelper;

  public hRoot: THREE.Group = new THREE.Group();
  public draggedNode: THREE.Object3D | null = null;

  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();

  gridVisible = true;
  snapEnabled = false;
  currentTransformMode: 'translate' | 'rotate' | 'scale' = 'translate';

  private animationId!: number;
  private lastOrthoQuaternion = new THREE.Quaternion();
  public isDraggingTransform = false;
  private lastOrthographicFace?: number;
  private collisionHelper: THREE.BoxHelper | null = null;

  // OVERLAY UI STATE
  showOverlay = false;
  overlayX = 0;
  overlayY = 0;
  tooltipData = { x: 0, y: 0, z: 0 };

  // HIERARCHY LOGIC
  selectNode(node: THREE.Object3D) {
    if (!node.userData['locked'] && node.visible) {
      this.attachToTransform(node);
    }
  }

  toggleExpand(node: THREE.Object3D, event: Event) {
    event.stopPropagation();
    node.userData['expanded'] = !node.userData['expanded'];
  }

  toggleVisibility(node: THREE.Object3D, event: Event) {
    event.stopPropagation();
    node.visible = !node.visible;
    if (!node.visible && this.transformControl.object === node) {
      this.detachFromTransform();
    }
  }

  toggleLock(node: THREE.Object3D, event: Event) {
    event.stopPropagation();
    node.userData['locked'] = !node.userData['locked'];
    if (node.userData['locked'] && this.transformControl.object === node) {
      this.detachFromTransform();
    }
  }

  onDragStart(event: DragEvent, node: THREE.Object3D) {
    this.draggedNode = node;
    event.dataTransfer?.setData('text/plain', node.uuid);
    event.stopPropagation();
  }

  onDragOver(event: DragEvent, node: THREE.Object3D) {
    event.preventDefault();
    event.stopPropagation();
  }

  onDrop(event: DragEvent, node: THREE.Object3D) {
    event.preventDefault();
    event.stopPropagation();
    if (this.draggedNode && this.draggedNode !== node) {
      let isAncestor = false;
      let current: THREE.Object3D | null = node;
      while (current) {
        if (current === this.draggedNode) {
          isAncestor = true;
          break;
        }
        current = current.parent;
      }
      if (!isAncestor) {
        const oldParent = this.draggedNode.parent;

        node.attach(this.draggedNode);

        // Notify parametric shelves about changes dynamically
        if (oldParent instanceof ParametricShelf) oldParent.updateLayout();
        if (node instanceof ParametricShelf) node.updateLayout();
      }
    }
    this.draggedNode = null;
  }

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
    this.applySnapSettings();
  }

  setTransformMode(mode: 'translate' | 'rotate' | 'scale') {
    this.currentTransformMode = mode;
    if (this.transformControl) {
      this.transformControl.setMode(mode);
      this.updateTransformAxes();
    }
  }

  private updateTransformAxes() {
    if (!this.transformControl) return;
    const obj = this.transformControl.object;
    if (!obj) return;

    // We restrict shelves and cabinets to only rotate around the vertical Y axis
    const isRestricted = obj instanceof ParametricShelf || obj.name.includes('Shelf') || obj.name.includes('Cabinet');

    if (this.currentTransformMode === 'rotate' && isRestricted) {
      this.transformControl.showX = false;
      this.transformControl.showY = true;
      this.transformControl.showZ = false;
    } else {
      this.transformControl.showX = true;
      this.transformControl.showY = true;
      this.transformControl.showZ = true;
    }
  }

  private attachToTransform(obj: THREE.Object3D) {
    this.transformControl.attach(obj);
    this.updateTransformAxes();
    this.checkAndHighlightCollisions(obj);
  }

  private detachFromTransform() {
    if (this.transformControl.object) {
      this.clearCollisionHighlight(this.transformControl.object);
    }
    this.transformControl.detach();
    this.showOverlay = false;
    this.cdr.detectChanges();
  }

  private updateTooltip(obj: THREE.Object3D) {
    const vector = new THREE.Vector3();
    obj.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj);

    box.getCenter(vector);
    vector.y = box.max.y; // Hover above the object bounding box max

    // Project the 3D world position into 2D screen space
    vector.project(this.camera);

    const container = this.rendererContainer.nativeElement;
    const widthHalf = container.clientWidth / 2;
    const heightHalf = container.clientHeight / 2;

    this.overlayX = (vector.x * widthHalf) + widthHalf;
    this.overlayY = -(vector.y * heightHalf) + heightHalf - 40; // Pixel offset upwards

    if (this.currentTransformMode === 'translate') {
      this.tooltipData.x = obj.position.x;
      this.tooltipData.y = obj.position.y;
      this.tooltipData.z = obj.position.z;
    } else if (this.currentTransformMode === 'rotate') {
      this.tooltipData.x = THREE.MathUtils.radToDeg(obj.rotation.x);
      this.tooltipData.y = THREE.MathUtils.radToDeg(obj.rotation.y);
      this.tooltipData.z = THREE.MathUtils.radToDeg(obj.rotation.z);
    } else if (this.currentTransformMode === 'scale') {
      this.tooltipData.x = obj.scale.x;
      this.tooltipData.y = obj.scale.y;
      this.tooltipData.z = obj.scale.z;
    }

    this.cdr.detectChanges(); // Trigger Angular to update HUD
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
      if (node instanceof THREE.Mesh && node.visible && node !== this.ghostMesh) {
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

  private applySnapSettings() {
    if (!this.transformControl) return;
    if (this.snapEnabled) {
      this.transformControl.setTranslationSnap(1);
      this.transformControl.setRotationSnap(Math.PI / 8);
      this.transformControl.setScaleSnap(0.25);
    } else {
      this.transformControl.setTranslationSnap(null);
      this.transformControl.setRotationSnap(null);
      this.transformControl.setScaleSnap(null);
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
      0.1,
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

    this.transformControl = new TransformControls(this.camera, this.renderer.domElement);
    this.orbitControls.addEventListener('change', () => {
      if (this.camera instanceof THREE.OrthographicCamera) {
        // Prevent rotating horizontally/vertically via OrbitControls when locked to an Orthographic face
        this.camera.quaternion.copy(this.lastOrthoQuaternion);
      }
    });
    this.transformControl.addEventListener('change', () => {
      if (this.transformControl.object) {
        const obj = this.transformControl.object as any;
        if (typeof obj.onTransform === 'function') {
          obj.onTransform();
        }
        this.checkAndHighlightCollisions(this.transformControl.object);
        if (this.showOverlay) {
          this.updateTooltip(this.transformControl.object);
        }
      }
    });

    this.transformControl.addEventListener('dragging-changed', (event: any) => {
      this.isDraggingTransform = event.value;
      this.showOverlay = event.value;
      this.orbitControls.enabled = !event.value;

      if (this.showOverlay && this.transformControl.object) {
        this.updateTooltip(this.transformControl.object);
      } else {
        this.cdr.detectChanges(); // force hide on release

        // Auto-Snap products perfectly when translation gizmo is released!
        if (!event.value && this.transformControl.object) {
          const obj = this.transformControl.object as THREE.Mesh;
          if (obj && (obj.name.includes('Bottom Box') || obj.name.includes('Top Can'))) {
            this.autoSnapProductToShelf(obj);
          }
        }
      }
    });

    if (typeof (this.transformControl as any).getHelper === 'function') {
      this.scene.add((this.transformControl as any).getHelper());
    } else {
      this.scene.add(this.transformControl as any);
    }

    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown.bind(this));
  }

  private autoSnapProductToShelf(mesh: THREE.Mesh) {
    mesh.updateMatrixWorld(true);
    const meshWorldPos = new THREE.Vector3();
    mesh.getWorldPosition(meshWorldPos);

    let targetParent: THREE.Object3D | null = null;
    let minDist = Infinity;

    // Scan all parametric cabinets mathematically querying their internal shelves for vertical proximity
    const cabinets = this.hRoot.children.filter(c => c instanceof ParametricShelf);
    for (const cabinet of cabinets) {
      cabinet.updateMatrixWorld(true);
      const cabBox = new THREE.Box3().setFromObject(cabinet);
      if (cabBox.containsPoint(meshWorldPos) || cabBox.intersectsBox(new THREE.Box3().setFromObject(mesh))) {
        const shelves = cabinet.children.filter(c => c.name.includes('Shelf') || c.name === 'Cabinet Frame Top');
        for (const s of shelves) {
          s.updateMatrixWorld(true);
          const sPos = new THREE.Vector3();
          s.getWorldPosition(sPos);
          // Verify the shelf physically exists beneath the product bounding center gracefully
          if (sPos.y <= meshWorldPos.y + 1.0) {
            const dist = Math.abs(meshWorldPos.y - sPos.y);
            if (dist < minDist) {
              minDist = dist;
              targetParent = s;
            }
          }
        }
      }
    }

    if (targetParent) {
      // Inherit intentional 3D world drag manipulation offsets
      targetParent.attach(mesh);

      let parentWidth = 9.6;
      if ((targetParent as THREE.Mesh).geometry) {
        (targetParent as THREE.Mesh).geometry.computeBoundingBox();
        const pbox = (targetParent as THREE.Mesh).geometry.boundingBox;
        if (pbox) parentWidth = pbox.max.x - pbox.min.x;
      }

      mesh.geometry.computeBoundingBox();
      const bbox = mesh.geometry.boundingBox!;
      const newWidth = bbox.max.x - bbox.min.x;
      const newHeight = bbox.max.y - bbox.min.y;

      // Prevent hanging off physical shelf edges intentionally
      if (mesh.position.x + (newWidth / 2) > (parentWidth / 2)) {
        mesh.position.x = (parentWidth / 2) - (newWidth / 2);
      }
      if (mesh.position.x - (newWidth / 2) < -(parentWidth / 2)) {
        mesh.position.x = -(parentWidth / 2) + (newWidth / 2);
      }

      // Reset depth and rotation native flush
      mesh.position.z = 0;
      mesh.rotation.set(0, 0, 0);

      // Lock strict baseline height physically exactly corresponding to geometrical scale boundaries
      let baseLocalY = 0.1 + (newHeight / 2);
      mesh.position.y = baseLocalY;
    }
  }

  private onPointerDown(event: PointerEvent): void {
    if (this.isDraggingShape) return;
    if ((this.transformControl as any).axis !== null) return; // Allow gizmo translations naturally
    
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
      hit.object !== this.ghostMesh && 
      hit.object !== this.collisionHelper &&
      hit.object.visible
    );

    if (validIntersects.length > 0) {
      let selectedObject: THREE.Object3D | null = validIntersects[0].object;

      while (selectedObject && selectedObject !== this.hRoot) {
        if (selectedObject instanceof ParametricShelf) break;
        if (selectedObject.name.includes('Shelf') || selectedObject.name.includes('Box') || selectedObject.name.includes('Can') || selectedObject.name.includes('Sphere') || selectedObject.name.includes('Cylinder') || selectedObject.name.includes('Cone')) break;
        selectedObject = selectedObject.parent;
      }

      if (selectedObject && selectedObject !== this.hRoot) {
        this.attachToTransform(selectedObject);
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
           this.detachFromTransform();
           this.clearCollisionHighlights();
        } else if (event.button === 2 && this.transformControl.object) {
           this.showContextMenu = true;
           this.contextMenuX = event.clientX;
           this.contextMenuY = event.clientY;
           this.contextMenuObject = this.transformControl.object;
           this.cdr.detectChanges();
        }
    }
  }

  deleteSelectedObject() {
    this.showContextMenu = false;
    const obj = this.contextMenuObject || this.transformControl.object;
    if (obj) {
      this.detachFromTransform();
      const parent = obj.parent;
      if (parent) {
        parent.remove(obj);
        // Auto-recalculate surrounding parameter boundaries
        if (parent instanceof ParametricShelf) {
          parent.updateLayout();
        }
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

    // Fallback for TransformControls mapping
    if (typeof (this.transformControl as any).camera !== 'undefined') {
      (this.transformControl as any).camera = this.camera;
    }
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

  // SHAPE PALETTE DRAG & DROP LOGIC
  private ghostMesh: THREE.Mesh | null = null;
  private isDraggingShape = false;

  private draggedShapeType: string = '';

  onShapeDragStart(event: DragEvent, shapeType: string) {
    this.isDraggingShape = true;
    this.draggedShapeType = shapeType;
    event.dataTransfer?.setData('shape-type', shapeType);

    const emptyImage = new Image();
    emptyImage.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    event.dataTransfer?.setDragImage(emptyImage, 0, 0);

    this.createGhostShape(shapeType);
    event.stopPropagation();
  }

  onShapeDragEnd(event: DragEvent) {
    this.isDraggingShape = false;
    this.draggedShapeType = '';
    this.removeGhostShape();
  }

  createGhostShape(type: string) {
    this.removeGhostShape();

    let geo: THREE.BufferGeometry;
    let mat = new THREE.MeshBasicMaterial({
      color: 0x00ffaa,
      wireframe: false,
      transparent: true,
      opacity: 0.5,
      depthTest: false
    });

    switch (type) {
      case 'Sphere': geo = new THREE.SphereGeometry(5, 32, 32); break;
      case 'Cylinder': geo = new THREE.CylinderGeometry(5, 5, 10, 32); break;
      case 'Cone': geo = new THREE.ConeGeometry(5, 10, 32); break;
      case 'Cabinet': geo = new THREE.BoxGeometry(10, 10, 5); break;
      case 'Shelf': geo = new THREE.BoxGeometry(9.8, 0.4, 4.8); break;
      case 'Bottom Box': geo = new THREE.BoxGeometry(3.5, 2.5, 3.5); break;
      case 'Top Can': geo = new THREE.CylinderGeometry(0.8, 0.8, 2.0, 32); break;
      case 'Box': default: geo = new THREE.BoxGeometry(10, 10, 10); break;
    }

    this.ghostMesh = new THREE.Mesh(geo, mat);
    this.ghostMesh.raycast = () => { };
    this.scene.add(this.ghostMesh);
  }

  removeGhostShape() {
    if (this.ghostMesh) {
      this.scene.remove(this.ghostMesh);
      this.ghostMesh.geometry.dispose();
      (this.ghostMesh.material as THREE.Material).dispose();
      this.ghostMesh = null;
    }
  }

  private getCanvasIntersection(event: DragEvent): THREE.Vector3 {
    const container = this.rendererContainer.nativeElement;
    const rect = container.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / container.clientWidth) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / container.clientHeight) * 2 + 1;

    this.raycaster.setFromCamera(this.pointer, this.camera);
    let dropPosition = new THREE.Vector3();

    // 1. Raycast real 3D objects in the scene first
    const intersects = this.raycaster.intersectObject(this.hRoot, true);
    const validIntersects = intersects.filter(hit =>
      hit.object !== this.ghostMesh &&
      hit.object !== this.collisionHelper &&
      hit.object.visible
    );

    if (validIntersects.length > 0) {
      const hit = validIntersects[0];
      dropPosition.copy(hit.point);

      // Auto-preview perfect Shelf resting for Products during drag
      if (this.draggedShapeType === 'Bottom Box' || this.draggedShapeType === 'Top Can' || this.draggedShapeType === 'Shelf') {
        if (hit.object.name.includes('Cabinet Frame') && hit.object.parent instanceof ParametricShelf) {
          const cabinet = hit.object.parent;
          const shelves = cabinet.children.filter(c => c.name.includes('Shelf') || c.name === 'Cabinet Frame Top');
          let closestShelf: THREE.Object3D | null = null;
          let minDist = Infinity;
          for (let s of shelves) {
            s.updateMatrixWorld(true);
            const shelfWorldPos = new THREE.Vector3();
            s.getWorldPosition(shelfWorldPos);
            const dist = Math.abs(hit.point.y - shelfWorldPos.y);
            if (dist < minDist) { minDist = dist; closestShelf = s; }
          }
          if (closestShelf) {
            closestShelf.updateMatrixWorld(true);
            const sbox = new THREE.Box3().setFromObject(closestShelf);
            let extentsY = 0;
            if (this.ghostMesh && this.ghostMesh.geometry) {
              this.ghostMesh.geometry.computeBoundingBox();
              const bbox = this.ghostMesh.geometry.boundingBox;
              if (bbox) extentsY = (bbox.max.y - bbox.min.y) / 2;
            }
            // Preview precisely resting mathematically flushed against the global highest Y-edge of the shelf!
            dropPosition.y = sbox.max.y + extentsY;
            // Lock visual depth preview to the exact physical internal shelf plane Z-axis natively
            dropPosition.z = (new THREE.Vector3().setFromMatrixPosition(closestShelf.matrixWorld)).z;
            return dropPosition;
          }
        }
      }

      if (hit.face) {
        const hitNormal = hit.face.normal.clone();
        const nMat = new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld);
        hitNormal.applyMatrix3(nMat).normalize();

        // Dynamically offset by the size of the ghost shape we are holding!
        if (this.ghostMesh && this.ghostMesh.geometry) {
          this.ghostMesh.geometry.computeBoundingBox();
          const bbox = this.ghostMesh.geometry.boundingBox;
          if (bbox) {
            const extents = new THREE.Vector3(
              (bbox.max.x - bbox.min.x) / 2,
              (bbox.max.y - bbox.min.y) / 2,
              (bbox.max.z - bbox.min.z) / 2
            );
            // Calculate exactly how far to push it out along the normal to rest perfectly
            const offsetDist = Math.abs(hitNormal.x * extents.x) +
              Math.abs(hitNormal.y * extents.y) +
              Math.abs(hitNormal.z * extents.z);
            dropPosition.addScaledVector(hitNormal, offsetDist);
          }
        }
      }
    } else {
      // 2. We are dropping into empty space -> use the mathematical Grid Planes
      let activeGrid = this.gridHelperXZ;
      let mathPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

      if (this.gridHelperXY.visible) {
        activeGrid = this.gridHelperXY;
        mathPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
      } else if (this.gridHelperYZ.visible) {
        activeGrid = this.gridHelperYZ;
        mathPlane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);
      }

      const intersection = this.raycaster.ray.intersectPlane(mathPlane, dropPosition);
      if (!intersection) {
        dropPosition = new THREE.Vector3();
        this.raycaster.ray.at(30, dropPosition);
      }

      if (!this.snapEnabled) {
        if (this.ghostMesh && this.ghostMesh.geometry) {
          this.ghostMesh.geometry.computeBoundingBox();
          const bbox = this.ghostMesh.geometry.boundingBox;
          if (bbox) {
            if (activeGrid === this.gridHelperXZ) dropPosition.y += (bbox.max.y - bbox.min.y) / 2;
            else if (activeGrid === this.gridHelperXY) dropPosition.z += (bbox.max.z - bbox.min.z) / 2;
            else if (activeGrid === this.gridHelperYZ) dropPosition.x += (bbox.max.x - bbox.min.x) / 2;
          }
        } else {
          if (activeGrid === this.gridHelperXZ) dropPosition.y += 5;
          else if (activeGrid === this.gridHelperXY) dropPosition.z += 5;
          else if (activeGrid === this.gridHelperYZ) dropPosition.x += 5;
        }
      }
    }

    if (this.snapEnabled) {
      dropPosition.x = Math.round(dropPosition.x);
      dropPosition.y = Math.round(dropPosition.y);
      dropPosition.z = Math.round(dropPosition.z);
    }

    return dropPosition;
  }

  onCanvasDragOver(event: DragEvent) {
    event.preventDefault();
    if (this.ghostMesh) {
      const dropPosition = this.getCanvasIntersection(event);
      this.ghostMesh.position.copy(dropPosition);
      this.ghostMesh.updateMatrixWorld(true);

      const ghostBox = new THREE.Box3().setFromObject(this.ghostMesh);
      ghostBox.expandByScalar(-0.1); // Tolerance to allow snapping perfectly side-by-side without triggering collision

      let isOverlapping = false;
      for (const child of this.hRoot.children) {
        if (child.visible) {
          const childBox = new THREE.Box3().setFromObject(child);
          if (ghostBox.intersectsBox(childBox)) {
            isOverlapping = true;
            break;
          }
        }
      }

      const material = this.ghostMesh.material as THREE.MeshBasicMaterial;
      if (isOverlapping) {
        material.color.setHex(0xff3333); // Red collision warning
      } else {
        material.color.setHex(0x00ffaa); // Green safe drop
      }
    }
  }

  onCanvasDrop(event: DragEvent) {
    event.preventDefault();
    const shapeType = event.dataTransfer?.getData('shape-type');
    if (!shapeType) return;

    this.isDraggingShape = false;
    const dropPosition = this.getCanvasIntersection(event);

    let targetParent: THREE.Object3D = this.hRoot;

    if (shapeType === 'Shelf') {
      const intersects = this.raycaster.intersectObject(this.hRoot, true);
      if (intersects.length > 0) {
        let current: THREE.Object3D | null = intersects[0].object;
        while (current && current !== this.hRoot) {
          if (current instanceof ParametricShelf) {
            targetParent = current;
            break;
          }
          current = current.parent;
        }
      }
    } else if (shapeType === 'Bottom Box' || shapeType === 'Top Can') {
      // Auto-detect nearby shelves for Products
      const intersects = this.raycaster.intersectObject(this.hRoot, true);
      const valid = intersects.filter(h => h.object !== this.ghostMesh && h.object !== this.collisionHelper && h.object.visible);

      if (valid.length > 0) {
        const hitObj = valid[0].object;
        if ((hitObj.name.includes('Shelf') || hitObj.name === 'Cabinet Frame Top') && hitObj.parent instanceof ParametricShelf) {
          targetParent = hitObj;
        } else if (hitObj.name.includes('Cabinet Frame') && hitObj.parent instanceof ParametricShelf) {
          // Ray hit the back/side wall of Cabinet! Mathematically sort shelves by Y distance and find closest.
          const cabinet = hitObj.parent as ParametricShelf;
          const shelves = cabinet.children.filter(c => c.name.includes('Shelf') || c.name === 'Cabinet Frame Top');
          let closestShelf: THREE.Object3D | null = null;
          let minDist = Infinity;

          for (let s of shelves) {
            s.updateMatrixWorld(true);
            const shelfWorldPos = new THREE.Vector3();
            s.getWorldPosition(shelfWorldPos);
            const dist = Math.abs(valid[0].point.y - shelfWorldPos.y);
            if (dist < minDist) {
              minDist = dist;
              closestShelf = s;
            }
          }
          if (closestShelf) {
            targetParent = closestShelf;
          }
        } else {
          targetParent = hitObj;
        }
      }
    }

    this.removeGhostShape();
    this.spawnShape(shapeType, dropPosition, targetParent);
  }

  spawnShape(type: string, position: THREE.Vector3, targetParent: THREE.Object3D = this.hRoot) {
    let mesh: THREE.Object3D;

    if (type === 'Cabinet') {
      mesh = new ParametricShelf();
      mesh.position.copy(position);
    } else {
      let geo: THREE.BufferGeometry;
      let mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, metalness: 0.1 });

      switch (type) {
        case 'Sphere':
          geo = new THREE.SphereGeometry(5, 32, 32);
          break;
        case 'Cylinder':
          geo = new THREE.CylinderGeometry(5, 5, 10, 32);
          break;
        case 'Cone':
          geo = new THREE.ConeGeometry(5, 10, 32);
          break;
        case 'Shelf':
          geo = new THREE.BoxGeometry(9.8, 0.4, 4.8);
          break;
        case 'Bottom Box':
          geo = new THREE.BoxGeometry(3.5, 2.5, 3.5);
          break;
        case 'Top Can':
          geo = new THREE.CylinderGeometry(0.8, 0.8, 2.0, 32);
          break;
        case 'Box':
        default:
          geo = new THREE.BoxGeometry(10, 10, 10);
          break;
      }
      mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(position);
    }

    mesh.name = `${type} ${Math.floor(Math.random() * 100)}`; // Basic ID

    if ((targetParent.name.includes('Shelf') || targetParent.name === 'Cabinet Frame Top') && targetParent.parent instanceof ParametricShelf) {
      // Product targets Shelf or Roof directly! Sequentially snap from Left side -> Right side.
      targetParent.add(mesh);

      let parentWidth = 9.6;
      if ((targetParent as THREE.Mesh).geometry) {
        (targetParent as THREE.Mesh).geometry.computeBoundingBox();
        const pbox = (targetParent as THREE.Mesh).geometry.boundingBox;
        if (pbox) parentWidth = pbox.max.x - pbox.min.x;
      }

      let currentX = -(parentWidth / 2); // Far left edge of array
      const padding = 0.2;

      // Find existing dimensions on this host to stack horizontally
      for (const child of targetParent.children) {
        if (child !== mesh && (child as THREE.Mesh).geometry) {
          const childMesh = child as THREE.Mesh;
          childMesh.geometry.computeBoundingBox();
          const bbox = childMesh.geometry.boundingBox;
          if (bbox) {
            const w = bbox.max.x - bbox.min.x;
            const rightEdge = child.position.x + ((w / 2) * child.scale.x);
            if (rightEdge > currentX) currentX = rightEdge;
          }
        }
      }

      const m = mesh as THREE.Mesh;
      m.geometry.computeBoundingBox();
      const bbox = m.geometry.boundingBox!;
      const newWidth = bbox.max.x - bbox.min.x;
      const newHeight = bbox.max.y - bbox.min.y;

      let localX = currentX + padding + (newWidth / 2);

      // Clamp to prevent spilling out the right side of the cabinet physically
      if (localX + (newWidth / 2) > (parentWidth / 2)) {
        localX = (parentWidth / 2) - (newWidth / 2);
      }

      // Top surface of the unscaled mesh geometry is exactly +0.1 for both Shelves and Frame Tops.
      let baseLocalY = 0.1 + (newHeight / 2);

      // Ensure perfect physical placement resting exactly directly natively to the top face mathematically!
      mesh.position.set(localX, baseLocalY, 0);

    } else if (targetParent instanceof ParametricShelf && type === 'Shelf') {
      targetParent.add(mesh); // Lock natively into local parent coordinates
      targetParent.updateLayout();
    } else if (targetParent !== this.hRoot) {
      this.hRoot.add(mesh); // Add to world to generate absolute matrices
      targetParent.attach(mesh); // Transfer safely without losing dropping position
    } else {
      this.hRoot.add(mesh);
    }

    this.attachToTransform(mesh);
    this.cdr.detectChanges(); // Sync UI Hierarchy panel
  }
}

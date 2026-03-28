import { Component, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ThreeViewer } from './three-viewer/three-viewer';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, ThreeViewer],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App {
  protected readonly title = signal('my-angular-app');
}

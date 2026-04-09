import {
  ApplicationConfig,
  LOCALE_ID,
  provideBrowserGlobalErrorListeners,
  provideZoneChangeDetection,
} from '@angular/core';
import { registerLocaleData } from '@angular/common';
import localeJa from '@angular/common/locales/ja';
import { provideRouter } from '@angular/router';
import { initializeApp, provideFirebaseApp } from '@angular/fire/app';
import { getFirestore, provideFirestore } from '@angular/fire/firestore';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { en_US, provideNzI18n } from 'ng-zorro-antd/i18n';
import { routes } from './app.routes';
registerLocaleData(localeJa);


const firebaseConfig = {
  apiKey: 'AIzaSyBsruStESBadPYdfJuZCwD9EVLtbpk0v6c',
  authDomain: 'kensyu10149.firebaseapp.com',
  databaseURL: 'https://kensyu10149-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId: 'kensyu10149',
  storageBucket: 'kensyu10149.firebasestorage.app',
  messagingSenderId: '974685599827',
  appId: '1:974685599827:web:78591b354f6bf8ba42aea6',
  measurementId: 'G-KFEF841K0T',
};

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    provideAnimationsAsync(),
    { provide: LOCALE_ID, useValue: 'ja' },
    provideNzI18n(en_US),
    provideFirebaseApp(() => initializeApp(firebaseConfig)),
    provideFirestore(() => getFirestore()),
  ],
};
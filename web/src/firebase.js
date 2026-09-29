import { initializeApp } from 'firebase/app'

let firebaseAppPromise

export function appForFirebase() {
  if (!firebaseAppPromise) {
    firebaseAppPromise = fetch('/api/auth/config')
      .then(async response => {
        if (!response.ok) throw new Error('Could not load Firebase sign-in settings.')
        const config = await response.json()
        if (!config.enabled) throw new Error('Firebase sign-in is not configured yet. Add the Firebase web app settings to the CDK deployment.')
        const localDevelopment = ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname)
        if (window.location.protocol !== 'https:' && !localDevelopment) throw new Error('Firebase sign-in requires HTTPS. Open the secure dashboard URL or use localhost for development.')
        return initializeApp({ apiKey: config.apiKey, authDomain: config.authDomain, projectId: config.projectId, appId: config.appId })
      })
      .catch(error => { firebaseAppPromise = undefined; throw error })
  }
  return firebaseAppPromise
}

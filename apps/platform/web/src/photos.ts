/**
 * 界面照片（开始页、登录页），来自 Unsplash；署名按 Unsplash 规则显示「Photo by 摄影师 on Unsplash」并链接回去（img/ATTRIBUTION.md）。
 * 照片随前端打包，运行时不访问 Unsplash。
 */
import writeUrl from './img/ui-write.jpg'
import patientsUrl from './img/ui-patients.jpg'
import researchUrl from './img/ui-research.jpg'
import loginUrl from './img/ui-login.jpg'

export type PhotoUse = 'write' | 'patients' | 'research' | 'login'
const UTM = 'utm_source=heurion&utm_medium=referral'
const PHOTOS: Record<PhotoUse, { url: string; by: string; profile: string; photo: string }> = {
  write: { url: writeUrl, by: "Abdulai Sayni", profile: "https://unsplash.com/@abdulaisayni80?utm_source=heurion&utm_medium=referral", photo: "https://unsplash.com/photos/a-notebook-with-a-stethoscope-on-top-of-it-next-to-a-laptop-u2EjDa_hYJI?utm_source=heurion&utm_medium=referral" },
  patients: { url: patientsUrl, by: "Vitaly Gariev", profile: "https://unsplash.com/@silverkblack?utm_source=heurion&utm_medium=referral", photo: "https://unsplash.com/photos/doctor-writing-on-a-patients-chart-8WYkI3cEZm8?utm_source=heurion&utm_medium=referral" },
  research: { url: researchUrl, by: "Lilian Do Khac", profile: "https://unsplash.com/@nailil?utm_source=heurion&utm_medium=referral", photo: "https://unsplash.com/photos/row-of-glass-bottles-filled-with-colored-liquids-cX7yzYiRmVY?utm_source=heurion&utm_medium=referral" },
  login: { url: loginUrl, by: "Fulvio Ciccolo", profile: "https://unsplash.com/@scentspiracy?utm_source=heurion&utm_medium=referral", photo: "https://unsplash.com/photos/a-person-is-pouring-something-into-a-glass-AcLWzh95u-Q?utm_source=heurion&utm_medium=referral" },
}

/** 一张带署名的照片面板（样式见 style.css 的 .start-photo） */
export function photoFigure(use: PhotoUse): string {
  const p = PHOTOS[use]
  return `<figure class="start-photo start-photo-${use}" style="background-image:url('${p.url}')" aria-hidden="false">
    <figcaption>Photo by <a href="${p.profile}" target="_blank" rel="noopener">${p.by}</a> on <a href="https://unsplash.com/?${UTM}" target="_blank" rel="noopener">Unsplash</a></figcaption></figure>`
}

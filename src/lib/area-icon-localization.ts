import { AREA_ICONS, AREA_ICON_CATEGORIES, AREA_ICON_WORDS, areaIconLabel, findAreaIcons, type AreaIcon } from "./area-icons";
import { createTranslator, type Language } from "./i18n";
import polish from "./area-icons.pl.json";

const labels: Record<AreaIcon, string> = polish;
const fold = (text: string) => text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/ł/g, "l");

export const areaIconLabelFor = (icon: AreaIcon, language: Language) => language === "pl" ? labels[icon] : areaIconLabel(icon);

/** Polish labels and category names join the original searchable names and tags. Stored icon IDs stay the same. */
export function findAreaIconsFor(query: string, language: Language): AreaIcon[] {
  if (language === "en") return findAreaIcons(query);
  const tx = createTranslator(language);
  const words = fold(query).split(/\s+/).filter(Boolean);
  return AREA_ICONS.filter((icon) => {
    const category = AREA_ICON_CATEGORIES.find(c => (c.icons as readonly AreaIcon[]).includes(icon));
    const text = fold([labels[icon], tx(category?.name ?? ""), icon, AREA_ICON_WORDS[icon]].join(" "));
    return words.every(word => text.includes(word));
  });
}

import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Bold, BookOpen,
  ChevronDown, ChevronUp, CircleQuestionMark, Code, Copy, Ellipsis,
  Eye, EyeOff, GalleryVerticalEnd, Group, Image, Link,
  List, PanelRight, PanelRightClose, PanelRightOpen, Plus, Redo2,
  RotateCcw, Save, Search, Table, TableColumnsSplit, TableRowsSplit,
  Trash2, Undo2, X
} from 'lucide';
import { iconPaths, iconSvg } from '../../icons.mjs';

const glyphs = {
  undo: Undo2,
  redo: Redo2,
  help: CircleQuestionMark,
  thumbs: GalleryVerticalEnd,
  outline: List,
  plus: Plus,
  copy: Copy,
  trash: Trash2,
  up: ChevronUp,
  down: ChevronDown,
  more: Ellipsis,
  rowAbove: TableRowsSplit,
  rowBelow: TableRowsSplit,
  colLeft: TableColumnsSplit,
  colRight: TableColumnsSplit,
  rowDel: Table,
  bold: Bold,
  code: Code,
  link: Link,
  search: Search,
  image: Image,
  arrowUp: ArrowUp,
  arrowDown: ArrowDown,
  arrowLeft: ArrowLeft,
  arrowRight: ArrowRight,
  reset: RotateCcw,
  close: X,
  group: Group,
  save: Save,
  book: BookOpen,
  panelRight: PanelRight,
  panelRightOpen: PanelRightOpen,
  panelRightClose: PanelRightClose,
  eye: Eye,
  eyeOff: EyeOff,
};
export function icon(name, size = 16) {
  return iconSvg(iconPaths(glyphs[name] || CircleQuestionMark), `class="mj-ic" width="${size}" height="${size}"`);
}

# Workazy Mobile Design System

## Visual source

Use all images in `/references` as design references.

The goal is not pixel-for-pixel copying of browser screenshots. The goal is the same recognizable Workazy identity rebuilt as a polished native iPhone app.

## Core palette direction

Use token names rather than scattered hex values:

- `background`
- `surface`
- `surfaceElevated`
- `surfaceSelected`
- `border`
- `borderStrong`
- `textPrimary`
- `textSecondary`
- `textMuted`
- `accent`
- `accentSoft`
- `success`
- `danger`
- `financeAccent`

Primary visual language:
- near-black background
- charcoal surfaces
- soft violet accent
- faint violet gradient only in hero/progress/selected states
- restrained mint/green for money/success
- white primary text

## Geometry

- large cards: ~24–28 radius
- inputs: ~18–22 radius
- pills/segmented controls: rounded but not cartoonish
- icon buttons: square with rounded corners
- bottom tab bar: floating-looking, safe-area aware, but stable and readable

## Typography

Prefer the native iOS system font unless a product-specific font is intentionally added.

Hierarchy:
- page title: large, bold
- section title: medium/semibold
- body: comfortable reading size
- label/meta: compact but not tiny
- numeric finance values: large, tabular where useful

Do not use all-caps for large body text.

## Main screen redesign

The current "Today" screen should be calmer.

Recommended order:

1. compact top area
   - date
   - title "Сегодня"
   - completion percent
   - settings icon

2. planning segmented tabs
   - Plan
   - Tasks
   - Goals

3. date selector
   - Today
   - Tomorrow
   - calendar icon

4. compact rhythm/progress card

5. quick add

6. plan list

Do not add unrelated dashboard widgets.

## Journal

Editor should feel like a personal space.

Top:
- Journal / Ideas segmented tabs
- New entry / History

Editor:
- date
- optional title
- large body field
- media buttons
- mood
- tags

Media buttons should be obvious and touch-friendly.

## Video recorder

Full black camera canvas.

Top:
- close
- timer when recording
- flip camera

Bottom:
- gallery/preview optional
- very large record/stop button
- minimal secondary controls

Record states:
- idle: outlined/filled red circle
- recording: red square inside active ring
- tap again to stop

After recording:
- full-screen preview
- Re-record
- Use video

## Calendar

Use a clean month grid, selected day card, and event list/timeline below.

## Finance

Use green/mint only here for semantic differentiation.

Main cards:
- balance
- daily limit
- spent today
- remaining today

Keep expense entry simple.

## Motion

Use minimal native-feeling motion:
- tab selection
- modal transitions
- recording state
- checkbox completion
- progress changes

Avoid decorative animation loops.

## Haptics

Use haptics sparingly:
- plan completion
- successful save
- recording start/stop
- destructive confirmation

## Accessibility

- dynamic text should remain usable
- icon buttons have labels
- contrast remains high
- selected state not communicated by color alone
- minimum touch targets around 44pt

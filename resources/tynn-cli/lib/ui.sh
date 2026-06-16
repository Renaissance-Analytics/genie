#!/usr/bin/env bash
# UI helpers for tynn-cli scripts
# Provides checkbox selection, progress bars, and prompts

# ─────────────────────────────────────────────────────────────────────────────
# Terminal capabilities
# ─────────────────────────────────────────────────────────────────────────────

# Check if we're in a terminal
is_tty() {
  [[ -t 0 && -t 1 ]]
}

# Colors (only if terminal supports it)
if [[ -t 1 ]] && command -v tput >/dev/null 2>&1; then
  BOLD=$(tput bold)
  DIM=$(tput dim)
  RESET=$(tput sgr0)
  GREEN=$(tput setaf 2)
  YELLOW=$(tput setaf 3)
  BLUE=$(tput setaf 4)
  CYAN=$(tput setaf 6)
else
  BOLD=""
  DIM=""
  RESET=""
  GREEN=""
  YELLOW=""
  BLUE=""
  CYAN=""
fi

# ─────────────────────────────────────────────────────────────────────────────
# Checkbox Selection UI
# ─────────────────────────────────────────────────────────────────────────────

# Display checkbox selection menu
# Usage: checkbox_select "prompt" "option1" "option2" ...
# Returns: Space-separated list of selected indices (0-based)
# Special: First option "All" selects all others
checkbox_select() {
  local prompt="$1"
  shift
  local options=("$@")
  local count=${#options[@]}
  local selected=()
  local current=0

  # Initialize all as unselected
  for ((i=0; i<count; i++)); do
    selected[$i]=0
  done

  # Hide cursor
  printf "\033[?25l"

  # Trap to restore cursor on exit
  trap 'printf "\033[?25h"' EXIT

  while true; do
    # Clear and redraw
    printf "\033[${count}A\033[J" 2>/dev/null || true

    echo "${BOLD}${prompt}${RESET}"
    echo "${DIM}(Use arrow keys to navigate, space to toggle, enter to confirm)${RESET}"
    echo ""

    for ((i=0; i<count; i++)); do
      local prefix="  "
      local checkbox="[ ]"

      if [[ $i -eq $current ]]; then
        prefix="${CYAN}> ${RESET}"
      fi

      if [[ ${selected[$i]} -eq 1 ]]; then
        checkbox="${GREEN}[x]${RESET}"
      fi

      echo "${prefix}${checkbox} ${options[$i]}"
    done

    # Read single keypress
    local key
    IFS= read -rsn1 key

    case "$key" in
      $'\x1b')  # Escape sequence
        read -rsn2 key
        case "$key" in
          '[A')  # Up arrow
            ((current > 0)) && ((current--))
            ;;
          '[B')  # Down arrow
            ((current < count - 1)) && ((current++))
            ;;
        esac
        ;;
      ' ')  # Space - toggle
        if [[ $current -eq 0 && "${options[0]}" == "All" ]]; then
          # Toggle all
          if [[ ${selected[0]} -eq 1 ]]; then
            for ((i=0; i<count; i++)); do selected[$i]=0; done
          else
            for ((i=0; i<count; i++)); do selected[$i]=1; done
          fi
        else
          # Toggle single
          if [[ ${selected[$current]} -eq 1 ]]; then
            selected[$current]=0
            # Uncheck "All" if any unchecked
            [[ "${options[0]}" == "All" ]] && selected[0]=0
          else
            selected[$current]=1
          fi
        fi
        ;;
      '')  # Enter - confirm
        break
        ;;
    esac
  done

  # Show cursor
  printf "\033[?25h"
  trap - EXIT

  # Return selected indices (excluding "All" option)
  local result=()
  local start=0
  [[ "${options[0]}" == "All" ]] && start=1

  for ((i=start; i<count; i++)); do
    if [[ ${selected[$i]} -eq 1 ]]; then
      result+=("$i")
    fi
  done

  echo "${result[*]}"
}

# Simple menu select (single choice)
# Usage: menu_select "prompt" "option1" "option2" ...
# Returns: Selected index (0-based)
menu_select() {
  local prompt="$1"
  shift
  local options=("$@")
  local count=${#options[@]}
  local current=0

  printf "\033[?25l"
  trap 'printf "\033[?25h"' EXIT

  while true; do
    printf "\033[${count}A\033[J" 2>/dev/null || true

    echo "${BOLD}${prompt}${RESET}"
    echo ""

    for ((i=0; i<count; i++)); do
      if [[ $i -eq $current ]]; then
        echo "${CYAN}> ${options[$i]}${RESET}"
      else
        echo "  ${options[$i]}"
      fi
    done

    local key
    IFS= read -rsn1 key

    case "$key" in
      $'\x1b')
        read -rsn2 key
        case "$key" in
          '[A') ((current > 0)) && ((current--)) ;;
          '[B') ((current < count - 1)) && ((current++)) ;;
        esac
        ;;
      '') break ;;
    esac
  done

  printf "\033[?25h"
  trap - EXIT
  echo "$current"
}

# ─────────────────────────────────────────────────────────────────────────────
# Progress Bar
# ─────────────────────────────────────────────────────────────────────────────

# Show progress bar
# Usage: progress_bar current total "message"
progress_bar() {
  local current="$1"
  local total="$2"
  local message="${3:-Processing}"
  local width=40
  local percent=$((current * 100 / total))
  local filled=$((current * width / total))
  local empty=$((width - filled))

  local bar=""
  for ((i=0; i<filled; i++)); do bar+="█"; done
  for ((i=0; i<empty; i++)); do bar+="░"; done

  printf "\r${CYAN}%s${RESET} [${GREEN}%s${RESET}] %3d%% " "$message" "$bar" "$percent"
}

# Complete progress bar
progress_done() {
  echo ""
}

# ─────────────────────────────────────────────────────────────────────────────
# Prompts
# ─────────────────────────────────────────────────────────────────────────────

# Yes/No prompt
# Usage: confirm "message" [default: y/n]
# Returns: 0 for yes, 1 for no
confirm() {
  local message="$1"
  local default="${2:-y}"
  local prompt

  if [[ "$default" == "y" ]]; then
    prompt="[Y/n]"
  else
    prompt="[y/N]"
  fi

  while true; do
    printf "${BOLD}%s${RESET} %s " "$message" "$prompt"
    read -r response
    response="${response:-$default}"

    case "${response,,}" in
      y|yes) return 0 ;;
      n|no) return 1 ;;
      *) echo "Please answer yes or no." ;;
    esac
  done
}

# Text input prompt
# Usage: prompt_input "message" [default]
prompt_input() {
  local message="$1"
  local default="${2:-}"
  local prompt_suffix=""

  [[ -n "$default" ]] && prompt_suffix=" [${default}]"

  printf "${BOLD}%s${RESET}%s: " "$message" "$prompt_suffix"
  read -r response
  echo "${response:-$default}"
}

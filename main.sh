#!/bin/bash

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
plain='\033[0m'
NC='\033[0m'

PROJECT_DIR="/opt/DVHOST"
SERVICE_FILE="/etc/systemd/system/DVHOST_TEMPLATE.service"
VERSION='1.0.3'
SAVED_PROXY=""
[[ $EUID -ne 0 ]] && echo -e "${RED}Fatal error: ${plain} Please run this script with root privilege \n " && exit 1

set_proxy() {
    local default_msg=" (e.g., http://127.0.0.1:2080)"
    if [ -n "$SAVED_PROXY" ]; then
        default_msg=" [Default: $SAVED_PROXY]"
    fi
    echo -e "${YELLOW}Do you want to use a proxy for the installation process? (y/n) [n]: ${NC}"
    read -r use_proxy
    if [[ "$use_proxy" =~ ^[Yy]$ ]]; then
        echo -e "${YELLOW}Enter your proxy URL${default_msg}: ${NC}"
        read -r proxy_url
        if [ -z "$proxy_url" ] && [ -n "$SAVED_PROXY" ]; then
            proxy_url="$SAVED_PROXY"
        fi
        if [ -n "$proxy_url" ]; then
            if [ "$proxy_url" != "$SAVED_PROXY" ]; then
                sudo sed -i "s|^SAVED_PROXY=\".*\"|SAVED_PROXY=\"$proxy_url\"|" "$0"
            fi
            export http_proxy="$proxy_url"
            export https_proxy="$proxy_url"
            export all_proxy="$proxy_url"
            export HTTP_PROXY="$proxy_url"
            export HTTPS_PROXY="$proxy_url"
            echo -e "${GREEN}Proxy environment variables set to $proxy_url${NC}"
        fi
    fi
}

install_prerequisites() {
    if ! command -v jq &> /dev/null || ! command -v curl &> /dev/null || ! command -v unzip &> /dev/null; then
        if command -v apt-get &> /dev/null; then
            echo -e "${RED}jq, curl or unzip is not installed. Installing...${NC}"
            sleep 1
            sudo -E apt-get update
            sudo -E apt-get install -y jq curl unzip
        else
            echo -e "${RED}Error: Unsupported package manager. Please install jq, curl and unzip manually.${NC}\n"
            read -p "Press any key to continue..."
            exit 1
        fi
    fi
}

loader(){
    set_proxy
    install_prerequisites
    SERVER_IP=$(hostname -I | awk '{print $1}')
    SERVER_COUNTRY=$(curl -sS "http://ip-api.com/json/$SERVER_IP" | jq -r '.country')
    SERVER_ISP=$(curl -sS "http://ip-api.com/json/$SERVER_IP" | jq -r '.isp')
}

install_dependencies() {
    echo "Installing Node.js and required tools..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo -E apt update
    sudo -E apt install -y nodejs git
}

clone_project() {
    echo "Downloading the project to $PROJECT_DIR..."
    
    if [ -f "$PROJECT_DIR/dvhost.config" ]; then
        sudo cp "$PROJECT_DIR/dvhost.config" /tmp/dvhost.config.bak
        echo -e "${GREEN}dvhost.config backed up successfully.${NC}"
    fi

    sudo rm -rf "$PROJECT_DIR"
    sudo mkdir -p "$PROJECT_DIR"
    
    ZIP_URL="https://github.com/Selin2005/XUI-Subscription-Template/archive/refs/heads/master.zip"
    MIRROR_URL="https://mirror.ghproxy.com/https://github.com/Selin2005/XUI-Subscription-Template/archive/refs/heads/master.zip"
    
    echo "Downloading zip file via curl..."
    if ! sudo -E curl -L -o /tmp/xui-template.zip "$ZIP_URL"; then
        echo -e "${YELLOW}Direct download failed. Trying GitHub Mirror...${NC}"
        if ! sudo -E curl -L -o /tmp/xui-template.zip "$MIRROR_URL"; then
            echo -e "${RED}Failed to download the repository zip. Please check your proxy or internet connection.${NC}"
            exit 1
        fi
    fi
    
    echo "Extracting zip file..."
    sudo unzip -q -o /tmp/xui-template.zip -d /tmp/
    sudo mv /tmp/XUI-Subscription-Template-master/* "$PROJECT_DIR"/
    sudo rm -rf /tmp/XUI-Subscription-Template-master /tmp/xui-template.zip
    
    if [ -f "/tmp/dvhost.config.bak" ]; then
        echo "Restoring and merging config..."
        sudo cp "$PROJECT_DIR/dvhost.config" "/tmp/dvhost.config.new"
        
        while IFS= read -r line; do
            # Check if line looks like a variable assignment (optionally commented)
            if [[ "$line" =~ ^[[:space:]]*(#?)[[:space:]]*([A-Za-z0-9_]+)=(.*) ]]; then
                is_comment="${BASH_REMATCH[1]}"
                key="${BASH_REMATCH[2]}"
                val="${BASH_REMATCH[3]}"
                
                # Escape sed characters in value
                val_escaped=$(echo "$val" | sed -e 's/|/\\|/g' -e 's/&/\\&/g')

                if [ -n "$is_comment" ]; then
                    # It was commented in the backup.
                    # Find the key in the new config (whether commented or not) and replace with comment
                    sudo sed -i -E "s|^[[:space:]]*#?[[:space:]]*$key=.*|# $key=$val_escaped|" "$PROJECT_DIR/dvhost.config"
                else
                    # It was uncommented in the backup.
                    # Replace in the new config (whether commented or not)
                    sudo sed -i -E "s|^[[:space:]]*#?[[:space:]]*$key=.*|$key=$val_escaped|" "$PROJECT_DIR/dvhost.config"
                fi
            fi
        done < "/tmp/dvhost.config.bak"
        
        echo -e "${GREEN}dvhost.config merged and restored successfully.${NC}"
    fi

    cd "$PROJECT_DIR" || exit
}

install_project_dependencies() {
    echo "Installing project dependencies..."
    cd "$PROJECT_DIR" || exit
    if [ -n "$http_proxy" ]; then
        npm config set proxy $http_proxy
        npm config set https-proxy $https_proxy
    fi
    if ! npm install; then
        echo -e "${RED}Error: npm install failed! Please check the error messages above.${NC}"
        exit 1
    fi
}

create_service() {
    echo "Creating a systemd service for the project..."
    sudo bash -c "cat > $SERVICE_FILE" <<EOL
[Unit]
Description=DVHOST_TEMPLATE Service
After=network.target

[Service]
ExecStart=/usr/bin/node $PROJECT_DIR/server.js
Restart=always
User=$USER
Group=$USER
Environment=PATH=/usr/bin:/usr/local/bin
Environment=NODE_ENV=production
WorkingDirectory=$PROJECT_DIR

[Install]
WantedBy=multi-user.target
EOL
    sudo systemctl daemon-reload
    sudo systemctl enable DVHOST_TEMPLATE
    sudo systemctl start DVHOST_TEMPLATE
}

remove_project() {
    echo "Removing the project and its service..."
    sudo systemctl stop DVHOST_TEMPLATE
    sudo systemctl disable DVHOST_TEMPLATE
    sudo rm -rf "$PROJECT_DIR"
    sudo rm -f "$SERVICE_FILE"
    sudo systemctl daemon-reload
}

update_project() {
    echo "Updating the project..."
    clone_project
    install_project_dependencies
    sudo systemctl restart DVHOST_TEMPLATE
    clear
    echo "+---------------------------------------+"
    echo -e "| ${YELLOW}Update completed successfully! ${NC} |"
    echo "+---------------------------------------+"
}

edit_config_file(){

    nano /opt/DVHOST/dvhost.config

    sudo systemctl daemon-reload
    sudo systemctl enable DVHOST_TEMPLATE
    sudo systemctl start DVHOST_TEMPLATE
}

menu(){
    
    clear
    echo "+-----------------------------------------------------------------------------------------------+"
    echo "| ██╗  ██╗██╗   ██╗██╗   ████████╗███████╗███╗   ███╗██████╗ ██╗      █████╗ ████████╗███████╗  |"
    echo "| ╚██╗██╔╝██║   ██║██║   ╚══██╔══╝██╔════╝████╗ ████║██╔══██╗██║     ██╔══██╗╚══██╔══╝██╔════╝  |"
    echo "|  ╚███╔╝ ██║   ██║██║      ██║   █████╗  ██╔████╔██║██████╔╝██║     ███████║   ██║   █████╗    |"
    echo "|  ██╔██╗ ██║   ██║██║      ██║   ██╔══╝  ██║╚██╔╝██║██╔═══╝ ██║     ██╔══██║   ██║   ██╔══╝    |"
    echo "| ██╔╝ ██╗╚██████╔╝██║      ██║   ███████╗██║ ╚═╝ ██║██║     ███████╗██║  ██║   ██║   ███████╗  |"
    echo "| ╚═╝  ╚═╝ ╚═════╝ ╚═╝      ╚═╝   ╚══════╝╚═╝     ╚═╝╚═╝     ╚══════╝╚═╝  ╚═╝   ╚═╝   ╚══════╝  |"
    echo "+-----------------------------------------------------------------------------------------------+"                                        
    echo -e "| Telegram Channel : ${YELLOW}@DVHOST_CLOUD ${NC} | YouTube : ${RED}youtube.com/@dvhost_cloud${NC} |  Version : ${GREEN} ${VERSION} ${NC} "
    echo "+-----------------------------------------------------------------------------------------------+"            
    # echo "+-----------------------------------------------------------------------------------------------+"                                        
    # echo -e "| VPS Location: ${YELLOW}$SERVER_COUNTRY${NC} | Server IP:${RED} $SERVER_IP ${NC} | Server ISP:${GREEN} $SERVER_ISP${NC}" 
    # echo "+-----------------------------------------------------------------------------------------------+"     
    echo -e "|${GREEN} Server Location:${NC} $SERVER_COUNTRY ${NC}"
    echo -e "|${GREEN} Server IP:${NC} $SERVER_IP ${NC}"
    echo -e "|${GREEN} Server ISP:${NC} $SERVER_ISP ${NC}"
    echo "+-----------------------------------------------------------------------------------------------+"                                        
    echo -e "${YELLOW}|  1  - Install XUI Subscription Template"
    echo -e "|  2  - Edit Configuation"
    echo -e "|  3  - Unistall"
    echo -e "|  4  - Update XUI Subscription Template"
    echo -e "|  0  - Exit${NC}"
    echo "+-----------------------------------------------------------------------------------------------+"                                        
    
    read -p "Please choose an option: " choice
    
    case $choice in
        1)
            install_dependencies
            clone_project
            install_project_dependencies
            create_service
            clear
            echo "+---------------------------------------+"
            echo -e "| ${YELLOW}Installation completed successfully! ${NC} |"
            echo "+---------------------------------------+"

            ;;
            2) edit_config_file ;;
            3) remove_project ;;
            4) update_project ;;
            0)
                echo -e "${GREEN}Exiting program...${NC}"
                exit 0
            ;;
            *)
                echo "Not valid"
            ;;
    esac
    
}

loader
menu
; Show the app-themed front end on interactive installs. Silent updates use the
; same NSIS install section directly, including its existing restart behavior.
!macro preInit
  !ifndef BUILD_UNINSTALLER
    IfSilent themed_done
    ${IfNot} ${UAC_IsInnerInstance}
      !tempfile wizardBin
      !system 'cmd.exe /d /s /c ""${PROJECT_DIR}\scripts\setup-ui\compile.cmd" "${wizardBin}""' = 0
      InitPluginsDir
      File /oname=$PLUGINSDIR\IPTVSetup.exe "${wizardBin}"
      !delfile "${wizardBin}"
      !undef wizardBin
      !insertmacro check64BitAndSetRegView
      !insertmacro setInstallModePerUser
      StrCpy $R2 "$INSTDIR"
      !insertmacro setInstallModePerAllUsers
      StrCpy $R3 "$INSTDIR"
      StrCpy $R4 "user"
      ReadRegStr $0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
      ReadRegStr $1 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
      ${If} $0 != ""
      ${AndIf} $1 == ""
        StrCpy $R4 "all"
      ${EndIf}
      ${GetParameters} $0
      ClearErrors
      ${GetOptions} $0 "/allusers" $1
      IfErrors +2
      StrCpy $R4 "all"
      ClearErrors
      ${GetOptions} $0 "/currentuser" $1
      IfErrors +2
      StrCpy $R4 "user"
      !insertmacro GetDParameter $R5
      StrCpy $0 2
      ExecWait '"$PLUGINSDIR\IPTVSetup.exe" "$EXEPATH" "${APP_EXECUTABLE_FILENAME}" "$R2" "$R3" "$R4" "$R5"' $0
      SetErrorLevel $0
      Quit
    ${EndIf}
    themed_done:
  !endif
!macroend
